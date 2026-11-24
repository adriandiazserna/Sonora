Primera versión pública de Sonora, un reproductor de música para Windows pensado para escuchar en alta calidad mientras juegas, sin que se trabe la computadora.

## Qué descargar

| Archivo | Para quién |
|---|---|
| **Sonora-1.0.0-win-x64.zip** | La opción recomendada. Trae todo lo necesario: solo descomprime y abre `Sonora.exe`. |
| **Sonora-1.0.0-win-x64-ligero.zip** | Más pequeño, pero necesitas tener instalado el [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0). |
| **SHA256SUMS.txt** | Huellas de los archivos, para comprobar que la descarga no se modificó. |

Requisitos: Windows 10 u 11 (64 bits). WebView2 ya viene con Windows 11.

## Qué incluye

- Reproduce FLAC, WAV, MP3, M4A, ALAC y DSD (DSF), este último con un decodificador propio.
- DJ automático que analiza el BPM y la tonalidad de cada canción para mezclarlas.
- Ecualizador de 10 bandas, crossfade, reproducción sin pausas y ReplayGain.
- Fotos y biografías de artistas, géneros automáticos y conexión con Last.fm.
- Modo juego y modo TV con mando.
- Gasta alrededor de 240 MB de RAM mientras suena.

## Seguridad

Las credenciales de Last.fm se guardan cifradas, todo lo que sale a internet va por HTTPS y el servidor interno solo responde a la propia app. Los detalles están en [SECURITY.md](https://github.com/adriandiazserna/Sonora/blob/main/SECURITY.md).

## Aviso al abrirlo

El programa no está firmado digitalmente, así que Windows puede mostrar «Windows protegió tu PC». Para abrirlo, pulsa **Más información → Ejecutar de todas formas**.
