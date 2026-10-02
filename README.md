# Mis Cuentas

App para llevar las cuentas de clientes de una vendedora de catálogo/revista y de productos de mayoreo.
Funciona sin internet y guarda todo en el teléfono.

## Carpetas
| Carpeta | Qué hay |
|---|---|
| `www/` | La app (HTML, CSS y JavaScript). Aquí se hacen los cambios. |
| `android/` | Proyecto de Android generado por Capacitor. |
| `firma/` | **Llave de firma del APK. No la pierdas ni la compartas** (ver `firma/LEEME.txt`). |
| `apk/` | Los APK generados, listos para enviar. |
| `herramientas/` | Scripts para generar el APK y los íconos. |

## Generar el APK
Requisitos (ya instalados en esta computadora): Node.js, Java 17 y el Android SDK.

1. Haz tus cambios en `www/`.
2. Sube la versión en `package.json` (por ejemplo `1.0.0` → `1.0.1`). Android solo acepta una actualización si el número es mayor.
3. Ejecuta:
   ```
   npm run apk
   ```
4. El APK queda en `apk/MisCuentas-<versión>.apk`.

Si cambias el ícono: `npm run iconos` y luego `npm run apk`.

## Instalar el APK en el celular
1. Envía el archivo `.apk` por WhatsApp, correo o cable.
2. Ábrelo en el celular. Android pedirá **permitir instalar apps de esta fuente**; acéptalo.
3. Si aparece un aviso de Play Protect, elige **Instalar de todos modos**.

Para **actualizar**, se instala el APK nuevo encima del anterior. Los datos se conservan siempre que esté firmado con la misma llave de `firma/`.

## Probar en la computadora
```
npm run web
```
y abre http://localhost:8000

## Importante
- Los datos viven solo en el teléfono. Haz un **respaldo** seguido (la app avisa cada 7 días).
- Si se desinstala la app, se borran sus datos. Para recuperarlos hay que restaurar un respaldo.
- Si alguien usaba la versión web, sus datos no pasan solos al APK: tiene que hacer un respaldo en la web y restaurarlo en el APK.
