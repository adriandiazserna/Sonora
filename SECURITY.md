# Seguridad en Sonora

Sonora es una app de escritorio de **un solo usuario**: no tiene servidor en internet, cuentas propias ni base de datos remota. Por eso la seguridad no consiste en proteger un backend, sino en tres cosas: que **nada de fuera** pueda usar el servidor local, que **las credenciales** no queden legibles en disco y que **todo el tráfico** a internet vaya cifrado.

## Modelo de amenazas

| Amenaza | ¿Cómo se cubre? |
|---|---|
| Una página web abierta en tu navegador intenta leer tu música o tus datos pidiendo `http://localhost:47800/...` | Cada petición necesita una **cookie de sesión con un token aleatorio de 256 bits** que cambia en cada arranque. La cookie es `HttpOnly` y `SameSite=Strict`, la pone el propio host en WebView2 y nunca aparece en una URL. Además se rechaza cualquier petición con `Sec-Fetch-Site` distinto de `same-origin`. |
| DNS rebinding (un dominio que de pronto apunta a 127.0.0.1) | Se valida que la cabecera `Host` sea exactamente `localhost:<puerto>`. |
| Otra app de localhost (por ejemplo un servidor en el puerto 3000) incrusta recursos de Sonora | `Sec-Fetch-Site` y `Cross-Origin-Resource-Policy: same-origin` lo bloquean, aunque para el navegador sea el mismo «sitio». |
| SSRF: usar el proxy de imágenes `/img?u=` para llegar a tu router o a servicios internos | Solo se aceptan URLs `https://` de hosts públicos. Las IPs **ya resueltas por DNS** se comprueban antes de conectar, así que un dominio que apunte a `192.168.x.x` o `127.0.0.1` también se bloquea. La respuesta debe ser una imagen real (se comprueba su firma de bytes). |
| Robo de credenciales de Last.fm copiando `%APPDATA%\Sonora\lastfm.json` | La API key, el *shared secret* y la clave de sesión se guardan **cifrados con DPAPI** (ámbito de usuario y entropía propia). Solo tu cuenta de Windows puede descifrarlos. Los archivos antiguos en texto plano se migran solos al primer arranque. |
| La interfaz filtra los secretos | El *shared secret* y la sesión **nunca salen del núcleo .NET**. La interfaz solo recibe la API key enmascarada (`abcd…wxyz`). |
| Contenido externo malicioso (biografías, nombres, etiquetas) inyecta código en la interfaz | La interfaz construye el DOM con `textContent`, nunca con `innerHTML` de datos externos. Además hay una **Content Security Policy** estricta: solo scripts propios, sin `eval` ni scripts en línea, sin iframes, sin formularios y sin conexiones a otros orígenes. |
| La vista web navega a un sitio externo o abre `file:`, `javascript:` u otros protocolos | WebView2 solo puede mostrar la interfaz local. Cualquier otro enlace se cancela y, si es `https://`, se abre en tu navegador. Solo se aceptan navegadores registrados en Windows, nunca un ejecutable arbitrario. |
| Tráfico interceptado en una red Wi-Fi pública | **HTTPS forzado**: el cliente HTTP rechaza cualquier petición que no sea `https://` antes de que salga de la PC, y .NET nunca sigue una redirección de HTTPS a HTTP. Los enlaces `http://` de imágenes se reescriben a `https://`. |
| Permisos del navegador (micrófono, cámara, ubicación) o descargas | Se niegan siempre. Las DevTools están apagadas en la versión final (solo se activan con `SONORA_DEVTOOLS=1`). |

## ¿Y las contraseñas?

Sonora **no pide ni guarda tu contraseña de Last.fm**. Usa el flujo oficial de autenticación de escritorio: tú autorizas la app en la web de Last.fm y Sonora solo recibe una clave de sesión, que se puede revocar desde tu cuenta en cualquier momento. Es más seguro que guardar una contraseña, aunque fuera con hash.

Hacerle hash al *shared secret* no sirve: Sonora lo necesita en claro para firmar cada petición. Por eso se **cifra** con DPAPI en lugar de hashearlo. El MD5 que aparece en `LastFm.cs` lo exige el protocolo de firmas de Last.fm (`api_sig`); no se usa para guardar nada.

## Claves de API en el código

- **Last.fm:** cada usuario usa su propia API key, que se escribe en Ajustes y se guarda cifrada. No hay ninguna clave en el repositorio.
- **TheAudioDB:** se usa `123`, la clave pública de pruebas que la propia API documenta. Si tienes una clave propia, ponla en la variable de entorno `SONORA_AUDIODB_KEY`.
- **Deezer:** su búsqueda pública no necesita clave.

## Reportar un problema

Si encuentras una vulnerabilidad, abre un *issue* sin detalles explotables o escríbeme por privado desde mi perfil de GitHub.
