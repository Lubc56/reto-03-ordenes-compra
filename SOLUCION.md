# SOLUCIÓN · Agente "Órdenes de Compra SAP"

## 1. Problema en una frase

La analista administrativa digita a mano en SAP cada orden de compra a partir de un correo con tres adjuntos y valida de memoria que proveedor, centro de costo, aprobador y montos cuadren. Le duele a ella (tiempo y errores que se corrigen en el cierre contable), a contabilidad y auditoría (control no sistemático) y a la dirección, que no sabe cuántas OC se crean después de llegar la factura.

## 2. Arquitectura

```
┌──────────────┐ POST /api/chat ┌───────────────────────────────────────────────┐
│ web/ (chat)  │ ─────────────▶ │ src/server.ts  (node:http, sin framework)     │
│ · historial  │ ◀───────────── │   └ src/agent/ciclo.ts   ciclo del agente     │
│ · tool calls │ reply, toolCalls│       ├ src/llm/adapter.ts  interfaz propia  │
│ · confirmar  │ needsConfirmation│      │   ├ anthropic.ts (Claude)            │
└──────────────┘                │       │   └ simulado.ts  (guion, sin clave)   │
                                │       ├ src/agent/herramientas.ts registro zod│
                                │       └ src/agent/sesiones.ts memoria+archivo │
                                └──────────────┬────────────────────────────────┘
                                               │ execute(args, ctx)
                                ┌──────────────▼────────────────────────────────┐
                                │ src/tools/oc.ts   oc_leer_paquete · oc_validar │
                                │   oc_construir_payload · oc_generar_evidencia  │
                                │   oc_crear                                     │
                                │ src/domain/  paquete · validacion (RC1–RC10)   │
                                │   payload · evidencia · control · confirmaciones│
                                │ src/sap/adapter.ts (interfaz) · mock.ts        │
                                └──────┬───────────────────────────┬────────────┘
                              fixtures/ (solo lectura)       out/ (escritura)
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Reglas de conducta, flujo, formato de respuesta, confirmación. |
| Conocimiento | `src/knowledge/ordenes-compra.md` | Actores, maestros, RC1–RC10 explicadas, OC retroactivas, salidas. |
| Ejecución | `src/tools/oc.ts` + `src/domain/` | Toda la lógica de negocio, determinista y sin modelo. |
| Parámetros de negocio | `src/domain/reglas.ts` | Tolerancias (2 %, ± 1), sociedad, numeración, límite de 40 caracteres. |

Prompt y conocimiento se leen en cada turno: cambiarlos no requiere reiniciar ni tocar el servidor. Un cambio de política (por ejemplo, la tolerancia de RC5) se hace en `reglas.ts`, sin tocar herramientas ni servidor.

## 3. Ciclo del agente

`ejecutarTurno` (`src/agent/ciclo.ts`):

1. **Confirmación humana.** Antes de llamar al modelo, el servidor revisa si la sesión tiene confirmaciones pendientes y si el mensaje las resuelve: botón *Confirmar/Cancelar* del front o texto inequívoco ("confirmo", "sí", "cancelar"). Si es así, marca la confirmación como otorgada en `src/domain/confirmaciones.ts` y agrega una nota `[Sistema]` al mensaje.
2. **Presupuesto.** Si la sesión o el proceso superaron su tope de tokens, responde sin llamar al modelo.
3. **Bucle.** `proveedor.enviar(historial, herramientas)`. Si hay llamadas a herramientas, se validan con zod, se ejecutan en serie, se registran en `out/log.jsonl` y en el historial visible, y se devuelven al modelo. Si no hay llamadas, esa es la respuesta.
4. **Tope de iteraciones (CA1).** Al llegar a `MAX_ITERACIONES` (25) se hace una última vuelta con `tool_choice: none` para que el modelo diga qué tiene y qué falta. Si esa vuelta falla, se responde con la lista de herramientas ejecutadas.
5. **Errores (CA5).** Un error del proveedor (`ErrorLLM`: timeout, rate limit, clave inválida…) se devuelve como texto claro en el chat. La sesión sigue viva y el historial queda consistente: los mensajes consecutivos del mismo rol se unen al convertir.

**La confirmación la impone el diseño, no solo el prompt (CA3).** `oc_validar` registra que el caso requiere confirmación. `oc_crear` con confirmaciones exige `confirmado: true` **y** que el servidor haya otorgado la confirmación a partir de un mensaje humano. Si el modelo pasa `confirmado: true` por su cuenta, la herramienta responde "el usuario todavía no ha confirmado", registra el intento como pendiente y no crea nada. `needsConfirmation` sale del registro, no del texto del modelo, y el front resalta ese estado con un banner.

**El modelo no puede afirmar ni alterar valores (CA2).** Las herramientas son la única fuente de valores. Además, aunque el contrato acepta `paquete`, `derivados` y `payload`, las herramientas **recalculan todo desde los fixtures**. `oc_crear` compara los campos críticos del payload recibido con el calculado y rechaza la creación si difieren (`rechazada` en control).

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-opus-5-5`, con esfuerzo `medium` (configurable con `LLM_MODEL` y `LLM_EFFORT`).
- **Por qué:** el trabajo crítico es seguir reglas estrictas (no inventar valores, no confirmar por el usuario), orquestar 5 herramientas en orden y presentar tablas claras en español. Opus es fuerte en uso de herramientas y adherencia a instrucciones. Como la lógica de negocio es determinista, el modelo no necesita "razonar" los controles, solo explicarlos.
- **Costo estimado por caso** (precios de lista: USD 4 / 20 por millón de tokens de entrada/salida; lectura de caché USD 0,20):

| Concepto | Estimación |
|---|---|
| Llamadas al modelo por caso | ~6 (una por herramienta + respuesta final) |
| Entrada acumulada | ~60 k tokens (system + herramientas ~5 k, más historial creciente) |
| Salida (incluye razonamiento) | ~3–5 k tokens |
| **Costo sin caché** | **≈ USD 0,30–0,35** |
| **Costo con caché de prompt** (activado) | **≈ USD 0,10–0,15** |

La API devuelve `uso` y `usoSesion` en cada respuesta para medir el costo real. Para bajar costos: `LLM_MODEL=claude-haiku-5-5` (≈ 40 veces más barato), viable porque la dificultad está en las herramientas y no en el modelo.

- **Alternativa sin costo:** `LLM_PROVIDER=gemini` con `GEMINI_API_KEY` (plan gratuito de Google AI Studio, modelo `gemini-flash-latest`). Usa un adaptador compatible con OpenAI (`src/llm/compatible-openai.ts`) que también sirve para Groq u Ollama (`LLM_PROVIDER=compatible`). El mensaje del asistente se reenvía intacto para conservar la `thought_signature` que exige Gemini 3.
- **Fallback:** se activa `fallbacks: "default"` (beta del API): si el modelo declina por política, el API reintenta en el modelo recomendado sin que el turno falle.

## 5. Matriz de controles

| Regla | Implementación (`src/domain/validacion.ts`) | Tipo |
|---|---|---|
| RC1 | Búsqueda por NIT normalizado (sin puntos ni dígito de verificación); sin NIT, por nombre normalizado (sin tildes, puntuación ni mayúsculas, coincidencia exacta). Verifica `activo`. | Bloqueo |
| RC2 | Aprobación presente, con "aprobado/a" sin negación ("no aprobado", "rechazado") y remitente en `aprobadores` del centro. Si el aprobador está autorizado en **otro** centro, lo dice como pista. | Bloqueo |
| RC3 | `valor_total ≤ tope` del aprobador en ese centro. Si el aprobador no es del centro y **ningún** aprobador del centro cubre el monto, bloqueo propio; si alguno lo cubre, "no aplica" (ya lo bloquea RC2). | Bloqueo |
| RC4 | Centro existente y subárea dentro de sus subáreas. | Bloqueo |
| RC5 | `abs(cot − sol) / sol > 2 %` → confirmación con ambos valores, diferencia y porcentaje. Sin cotización → confirmación. | Confirmación |
| RC6 | Sin indicador → se deriva del proveedor y se pide confirmación; se contrasta con la tasa de IVA de la cotización. Indicador inexistente en el maestro → bloqueo. | Confirmación + derivado |
| RC7 | Sin condición → se deriva del proveedor y solo se informa. Condición inexistente → bloqueo. | Derivado |
| RC8 | `factura.fecha < fecha_solicitud` → confirmación y `retroactiva = true` (va a `control.csv`). | Confirmación |
| RC9 | Fecha de aprobación (tal como está escrita, con su zona) `< fecha_solicitud` → confirmación. | Confirmación |
| RC10 | `abs(cantidad × valor_unitario − valor_total) > 1` → bloqueo. | Bloqueo |

Cada regla es una función pura en una tabla `REGLAS`. Devuelve un estado (`ok`, `bloqueo`, `confirmacion`, `derivado`, `no_aplica`), un detalle y, si aplica, un hallazgo con **acción sugerida**. `oc_validar` devuelve además `controles[]`, el estado de las 10 reglas, para mostrar "qué pasó y qué no".

**La más difícil: RC2/RC3 juntas (sol-003).** El PRD dice "tope del aprobador para ese centro", pero en sol-003 el aprobador no pertenece al centro: no hay tope que comparar. La salida fue separar los dos hechos útiles. Por un lado, quien aprobó no tiene autoridad (RC2). Por otro, nadie en CC-2020 puede aprobar 74 M, porque el máximo es 30 M (RC3). La recomendación sale de los datos: Felipe Vargas sí es aprobador de CC-3030 (Comercial) y el correo menciona "preventa", subárea de CC-3030. El agente sugiere revisar si el centro está mal imputado, en vez de solo decir "no".

## 6. Diseño del adaptador SAP real

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV`** (S/4HANA), expuesto a través de **SAP Integration Suite** o de la API Management del cliente. Si el sistema fuera ECC, la alternativa es `BAPI_PO_CREATE1` + `BAPI_TRANSACTION_COMMIT` vía RFC desde un middleware. Razones con viabilidad no confirmada: OData es la API publicada y estable de SAP para OC, se habilita con un *Communication Arrangement* (SAP_COM_0053) sin desarrollo ABAP, valida igual que ME21N y permite consultar por referencia, lo que da la idempotencia. La interfaz `SapAdapter` ya aísla la decisión: el cambio es una clase nueva en `src/sap/`.

**Mapeo del payload (7.4 → `A_PurchaseOrder`):**

| Payload | OData | Nota |
|---|---|---|
| `sociedad` | `CompanyCode` | |
| `organizacion_compras` | `PurchasingOrganization` | `PurchasingGroup` y `PurchaseOrderType = NB` por configuración |
| `proveedor.codigo_sap` | `Supplier` | |
| `moneda` | `DocumentCurrency` | |
| `condiciones_pago` | `PaymentTerms` | |
| `referencia.solicitud_id` | `CorrespncInternalReference` (o campo Z) | clave de idempotencia |
| `posiciones[].numero` | `to_PurchaseOrderItem.PurchaseOrderItem` | 10, 20… |
| `descripcion` | `PurchaseOrderItemText` | 40 caracteres |
| `cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` | UN→EA, H→H, MES→MON (tabla T006) |
| `precio_unitario` | `NetPriceAmount` | **neto**: hoy viene con IVA incluido, ver supuestos |
| `indicador_iva` | `TaxCode` | |
| `centro_costo` | `AccountAssignmentCategory = K` + `to_AccountAssignment.CostCenter` | |
| `subarea` | campo de extensión (`YY1_Subarea`) o texto de posición | no existe estándar |
| `aprobador` + PDF | `API_CV_ATTACHMENT_SRV` sobre el objeto BUS2012 | evidencia adjunta |
| `excepciones` | texto de cabecera | trazabilidad para auditoría |

**Autenticación y credenciales.** Usuario técnico de comunicación con OAuth 2.0 *client credentials* (o certificado X.509) y permisos mínimos: crear y leer OC y adjuntos. Las credenciales viven en un gestor de secretos (Azure Key Vault o AWS Secrets Manager) y las lee solo el adaptador en el backend. Nunca están en el prompt, en el agente, en el front ni en los logs. El modelo no ve ni un token: llama a `oc_crear` y la herramienta usa el adaptador.

**Idempotencia y errores parciales.**
- Antes de crear: buscar por `solicitud_id` (en SAP y en un registro propio con estado `en_curso` / `creada`).
- Timeout en el POST: **no** reintentar a ciegas. Se vuelve a consultar por referencia; si la OC existe, se devuelve ese número.
- Reintentos con backoff solo para 429 y 5xx, siempre detrás de la consulta por referencia.
- Error parcial (OC creada, adjunto fallido): estado `creada_sin_evidencia`, se reintenta **solo** el adjunto y se alerta. La OC nunca se recrea.
- Con BAPI: si `RETURN` trae un mensaje tipo `E`, se hace `BAPI_TRANSACTION_ROLLBACK` y se devuelve el error legible.

**Plan B si la conexión no es viable.** El agente igual hace el 90 % del trabajo: lee, valida, decide y arma la OC. Hay tres salidas:
1. **OC lista para pegar**: una ficha con los campos en el orden de ME21N.
2. **Archivo de carga masiva** (CSV o plantilla del *Migration Cockpit* / LSMW) con todas las OC aptas del día, que se carga una vez.
3. **Script de SAP GUI** generado a partir del payload.

En los tres casos se adjunta el PDF de evidencia y se registra en `control.csv`, así que la medición de retroactivas no depende de la integración.

## 7. Lectura del proceso: OC retroactivas

En los fixtures, 1 de 6 solicitudes (sol-005) llega con la factura emitida 17 días antes de la solicitud. El correo del líder lo dice explícito: "Ya llegó la factura, por favor crear la OC para poder radicarla". La OC deja de ser un control previo al gasto y se convierte en un trámite para poder pagar: la compra ya ocurrió, sin cotización comparada a tiempo (la cotización también es anterior) y sin aprobación previa real.

A la dirección le diría tres cosas:
1. **Ya se puede medir.** Cada intento queda en `out/control.csv` con `retroactiva = true/false`. El indicador es % de OC retroactivas por mes, por centro de costo y por proveedor. Con 2–3 meses de datos se ve si es un problema de pocos proveedores recurrentes (servicios y suministros periódicos) o de toda la organización.
2. **No conviene bloquearlas todavía.** Bloquear sin alternativa frena el pago a proveedores y genera deuda. Lo propuesto es crearlas con confirmación explícita y marca, para medir sin romper la operación. La política final (tolerar o rechazar) es una decisión de la dirección; el sistema ya está listo para cualquiera de las dos.
3. **Cambio de proceso.** Para compras recurrentes (papelería, licencias, servicios mensuales), crear **OC abiertas o contratos marco** al inicio del período, con las facturas imputadas contra ellas: elimina la mayoría de retroactivas sin fricción. Para el resto, la regla "sin OC no hay pago" anunciada a proveedores, más un SLA corto de creación de OC (que el agente hace viable porque elimina la digitación). La meta medible es bajar el % de retroactivas trimestre a trimestre.

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Las herramientas recalculan desde los archivos; `paquete`, `derivados` y `payload` del modelo solo sirven para detectar alteraciones. | Usar los objetos que manda el modelo. | El riesgo nº 1 del PRD es que el modelo "arregle" un monto. Además ahorra tokens y elimina errores de copia del modelo. Costo: los argumentos quedan casi como decorativos frente al contrato. |
| 2 | Confirmación otorgada por el servidor a partir del mensaje humano (botón o texto). | Confiar en `confirmado: true` y en el prompt. | El prompt reduce el riesgo, el diseño lo elimina. Costo: la detección por texto es heurística; por eso existe el botón explícito y una nota `[Sistema]` para el modelo. |
| 3 | Ciclo propio + interfaz `ProveedorLLM` con dos implementaciones (Anthropic y simulada). | Tool Runner del SDK, LangChain o Vercel AI SDK. | El PRD evalúa el ciclo y que cambiar de proveedor no toque el ciclo; la implementación simulada lo demuestra y sirve de plan B sin clave. Costo: más código propio (tope, errores, conversión de mensajes). |
| 4 | `node:http` + HTML/JS sin build. | Express + React/Vite. | Menos dependencias, arranque en segundos, despliegue trivial. Costo: front más básico (markdown con `marked` + `DOMPurify` desde CDN). |
| 5 | Archivos en `out/` (jsonl, csv, json) y sesiones en memoria con respaldo en archivo. | Base de datos. | Es un no-objetivo del PRD y deja todo auditable a ojo. Costo: sin concurrencia entre instancias (se usa un candado en proceso). |
| 6 | Registrar en control solo los intentos de `oc_crear`, e instruir al agente a cerrar siempre con `oc_crear`. | Registrar también desde `oc_validar`. | Una fila = un intento de creación, que es lo que define HU-5. El demo y el agente generan las filas de bloqueadas y pendientes. |

## 9. Supuestos

- Los precios de la solicitud y la cotización vienen **con IVA incluido**. El payload 7.4 no tiene precio neto, así que se usa `valor_unitario` tal cual. Contra SAP real habría que enviar el neto (`precio / (1 + tasa)`).
- "Aprobado" = la palabra aprobado/a sin negación cercana. Firmas digitales o DKIM quedan fuera.
- Las fechas de aprobación se comparan por la fecha local escrita (con su zona), no convertidas a UTC.
- Factura con fecha **igual** a la solicitud no es retroactiva (la regla dice `<`).
- Sin cotización → confirmación (RC5), no bloqueo.
- Búsqueda de proveedor por nombre: coincidencia exacta normalizada, sin coincidencia aproximada, para no asociar el proveedor equivocado.
- Unidad: `H` si la descripción menciona horas, `MES` si es mensual, `UN` en otro caso.
- La trazabilidad usa, además de las fuentes listadas en el PRD, `correo`, `aprobacion` y `evidencia`, que también son parte del paquete.
- Sociedad y organización de compras fijas en `1000` (configurables en `reglas.ts`).
- Una posición por OC (las solicitudes traen un ítem).
- Correo y solicitud son obligatorios; sin ellos, `oc_leer_paquete` devuelve `{ ok: false }` con qué pedir.

## 10. Cobertura

| Historia | Estado | Notas |
|---|---|---|
| HU-1 Leer el paquete | ✅ Hecho | Adjuntos ausentes en `null` + `faltantes`; errores legibles. |
| HU-2 Validar | ✅ Hecho | RC1–RC10, `controles[]` y acción sugerida. |
| HU-3 Payload | ✅ Hecho | zod + `trazabilidad.json`. |
| HU-4 Evidencia | ✅ Hecho (P0 y P1) | `aprobacion.txt` y `aprobacion.pdf` con sha256; el mismo hash va en la OC. |
| HU-5 Crear OC | ✅ Hecho | Numeración desde 4500000001, idempotencia, `control.csv` por intento. |
| HU-6 Errores | ✅ Hecho | JSON malformado, monto no numérico (zod en español), paquete incompleto, caso inexistente. |
| `oc_leer_excel` (P1) | ❌ No hecho | Opcional. |
| Front, ciclo, adaptador, API | ✅ Hecho | Probado de punta a punta con el proveedor simulado. |
| Bonus `modulo/` | ✅ Hecho | Generado desde las mismas fuentes; `npm run modulo -- --check`. |
| Link público | ✅ Hecho | https://agente-ordenes-compra-calu.onrender.com (proveedor simulado). |

**Falta para producción:** adaptador SAP real (§6), lectura de `.xlsx`/PDF/`.eml` reales, autenticación de usuarios y auditoría de quién confirmó (hoy es "analista (sesión X)"), almacenamiento durable (base de datos u object storage) y candado distribuido, rate limiting por IP, pruebas automatizadas (unitarias por regla con los 6 fixtures como casos de oro) y observabilidad (trazas por turno y costo por caso).

## 11. Uso de IA

**Asistente utilizado.** Construí la solución con **Claude Code** (aplicación de escritorio, modelo Claude Opus 5.5); no usé otros asistentes. Para el modelo del agente consideré el plan gratuito de Gemini para una demostración en vivo sin costo: quedó integrado como proveedor opcional (`LLM_PROVIDER=gemini`), aunque por ahora el link público usa el proveedor simulado.

**Reparto del trabajo.** El reto se resolvió en 2 horas, un tiempo muy corto para un proyecto de este tamaño y con tantas posibilidades. La IA construyó prácticamente todo: arquitectura, código, front, `demo.ts`, despliegue y documentación. Mi papel fue dirigir y validar: entregarle el PRD, pedirle que explicara el plan mientras construía, ir aprendiendo el proyecto en marcha, pedir commits por bloques en GitHub, decidir un despliegue sin costo y probar el resultado. El diseño quedó definido casi por completo por el PRD: la IA siguió la arquitectura, el contrato de herramientas y las normas que este exige.

**Cómo lo validé.**
- Ejecuté los escenarios del PRD (los 6 casos, la idempotencia y la confirmación) con `demo.ts` y en el chat.
- Con mi experiencia de QA probé la página publicada buscando escenarios que se le podrían ocurrir a un usuario. Así encontré un bug: al pedir "procesa sol-001321321", el agente procesaba **y creaba** la OC de sol-001, porque la detección del caso tomaba solo 3 dígitos. Se corrigió en un único lugar (`casosEnTexto()`) y se verificó en local y en producción.
- En las pruebas del navegador apareció otro defecto (el banner de confirmación no se ocultaba por una regla de CSS), también corregido.

**Qué se descartó.** Por el poco tiempo se descartaron sugerencias que podían hacer fallar la entrega:
- Pagar una clave de un modelo: el link usa el proveedor simulado, que llama a las mismas herramientas.
- El despliegue con contenedor Docker: se cambió por el runtime nativo de Node de Render porque la imagen no se pudo verificar localmente.
- La herramienta opcional `oc_leer_excel` (P1).

**Límites que reconozco.** Doy fe de que la solución cumple los casos propuestos en el PRD, pero no puedo garantizar escenarios fuera de él: la cobertura de pruebas no es completa, no hay pruebas automatizadas y puede haber bugs que no alcancé a encontrar. Ninguno de los proveedores reales se ejecutó contra su API por falta de clave. El de Claude compila contra los tipos oficiales del SDK. El de Gemini se probó contra un servidor que imita su API, con sus validaciones de firmas y de esquema.

**Cómo me apropio del código.** Pedí a la IA una tutoría y una guía de estudio del proyecto (arquitectura, recorrido por cada archivo, reglas, decisiones y preguntas de defensa), que estudiaré durante la semana para poder explicar cada parte.

**Qué haría distinto.** La IA fue muy útil. La próxima vez abriría en paralelo sesiones dedicadas a entender el trasfondo y la funcionalidad completa mientras se construye, para preparar escenarios de prueba que en esta ocasión no alcancé a considerar.

## 12. Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| La conexión a SAP no es viable a corto plazo | Plan B (§6): ficha para pegar, carga masiva o script GUI; la validación y la medición no dependen de la integración. |
| Prompt injection en el texto de correos o cotizaciones | Las herramientas son la única fuente de valores, recalculan desde los archivos y no ejecutan shell; el prompt trata el contenido como dato; la creación exige confirmación otorgada por el servidor. |
| Suplantación del aprobador (el "De:" de un correo se puede falsificar) | Validar DKIM/SPF del correo original o mover la aprobación a un flujo firmado (workflow de SAP o firma digital). |
| Precio con IVA incluido enviado como neto | Calcular el neto con la tasa del indicador antes de enviarlo a SAP y validarlo contra la base gravable de la cotización. |
| Abuso de costo de la clave | Topes de iteraciones y de tokens por sesión y globales, `ACCESS_KEY`; falta rate limiting por IP. |
| Datos personales en logs (`log.jsonl` con correos) | Retención limitada, enmascarar correos y almacenamiento con acceso restringido. |
| Concurrencia entre instancias (duplicar OC) | Idempotencia por referencia en SAP + candado distribuido o restricción única en base de datos. |
| Confirmación mal interpretada por texto | Botón explícito como camino principal; la confirmación por texto solo aplica con pendientes y frases inequívocas. |
| Desalineación entre prompt, conocimiento y módulo | `modulo/` se genera desde las fuentes y `--check` lo valida (apto para CI). |
