---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia (actores, maestros, reglas RC1–RC10, OC retroactivas, payload y salidas). Úsalo al procesar o explicar una OC.
---
<!-- Generado por scripts/build-modulo.ts. No editar: edita la fuente y ejecuta npm run modulo. -->

# Proceso de órdenes de compra en Periferia

## Actores

| Actor | Rol |
|---|---|
| Solicitante | Necesita la compra. Envía el paquete por correo a compras@. |
| Líder aprobador | Aprueba el gasto respondiendo el correo con "Aprobado". |
| Analista administrativa | Crea la OC en SAP. Es quien conversa contigo y confirma excepciones. |
| Contabilidad / Auditoría | Consume `out/control.csv` y la evidencia de aprobación. |

## Paquete de entrada (por caso, en `fixtures/reto-03/solicitudes/<caso>/`)

- `correo.json`: correo del solicitante con la lista de adjuntos.
- `solicitud.json`: el Excel de solicitud normalizado (proveedor, descripción, centro de costo, subárea, cantidad, valores, moneda, IVA y condiciones de pago opcionales, fecha).
- `cotizacion.txt`: cotización del proveedor (NIT, ítems, subtotal, IVA, total, validez).
- `aprobacion.json`: respuesta del líder.
- `factura.txt`: solo aparece cuando la factura llegó antes que la OC.

Correo y solicitud son obligatorios. Si falta otro adjunto, la lectura lo reporta en `faltantes` y la validación decide si bloquea o pide confirmación.

## Maestros

- **Proveedores**: código SAP, NIT, condiciones de pago e indicador de IVA por defecto, activo/inactivo.
- **Centros de costo**: subáreas válidas y aprobadores con su tope en COP.
- **Indicadores de IVA**: C0 excluido · C1 IVA 19 % · C2 IVA 5 %.
- **Condiciones de pago**: Z000 inmediato · Z015 15 días · Z030 30 días · Z060 60 días (fecha factura).

## Reglas de control (las ejecuta `oc_validar`; tú las explicas)

| Regla | Qué verifica | Si falla |
|---|---|---|
| RC1 | El proveedor existe (por NIT; si no hay NIT, por nombre) y está activo. | Bloqueo: crear o reactivar el proveedor en Maestros. |
| RC2 | Hay aprobación explícita ("Aprobado") de un aprobador del centro de costo. | Bloqueo: pedir la aprobación a un aprobador válido. |
| RC3 | El valor total no supera el tope de ese aprobador en ese centro. | Bloqueo: aprobador con tope suficiente o escalar a la dirección. |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo: corregir con el solicitante. |
| RC5 | La cotización no difiere más de 2 % del valor de la solicitud. | Confirmación con ambos valores. Sin cotización: confirmación. |
| RC6 | Indicador de IVA informado y válido. | Si falta, se deriva del proveedor y se pide confirmación. |
| RC7 | Condiciones de pago informadas y válidas. | Si faltan, se derivan del proveedor; solo se informa. |
| RC8 | La factura no es anterior a la solicitud. | Confirmación; la OC queda marcada `retroactiva = true`. |
| RC9 | La aprobación no es anterior a la solicitud. | Confirmación. |
| RC10 | cantidad × valor unitario = valor total (± 1). | Bloqueo: corregir el Excel. |

**Bloqueo** = no se crea la OC. **Confirmación** = se crea solo si la analista confirma en el chat. **Derivado** = valor completado desde un maestro, que se informa.

## OC retroactivas

Una OC es retroactiva cuando la factura llegó antes que la solicitud: la compra ocurrió sin OC previa y sin cotización comparada a tiempo. La dirección quiere medirlas, no bloquearlas. Por eso se crean con confirmación y quedan marcadas en `control.csv`. Explícalo así cuando aparezca una.

## Construcción del payload

- Sociedad y organización de compras: `1000`.
- Proveedor, código SAP y NIT salen del maestro, nunca del texto del correo.
- Una posición (10) con el precio unitario de la **solicitud**, que es lo aprobado. Si la cotización difiere, eso es una confirmación (RC5), no un cambio de precio.
- Texto breve de la posición: máximo 40 caracteres (límite de SAP). Se recorta en límite de palabra y la descripción completa queda en la trazabilidad.
- Unidad: `H` si la descripción habla de horas, `MES` si es mensual y `UN` en el resto.
- Cada campo tiene su fuente en `out/<caso>/trazabilidad.json`.

## Salidas

| Archivo | Contenido |
|---|---|
| `out/<caso>/payload.json` | La OC tal como se envía a SAP. |
| `out/<caso>/trazabilidad.json` | Fuente de cada valor del payload. |
| `out/<caso>/aprobacion.txt` / `.pdf` | Evidencia de aprobación con sha256. |
| `out/sap/ordenes.jsonl` | SAP simulado: OC creadas, numeradas desde 4500000001. |
| `out/control.csv` | Un registro por intento: creada, existente, bloqueada, pendiente o rechazada. |
| `out/log.jsonl` | Todas las llamadas a herramientas. |

Crear dos veces la misma solicitud devuelve el número existente (idempotencia).
