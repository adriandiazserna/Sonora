Esta versión corrige cómo se ve Sonora en equipos con Windows 10.

## Qué cambió

- **Windows 10 y Windows 11 21H2:** la ventana podía verse negra o casi transparente, porque el efecto de cristal solo existe desde Windows 11 22H2. Ahora Sonora revisa la versión de Windows y, si no es compatible, usa un fondo sólido.
- En **Ajustes → Apariencia** se avisa cuando el cristal no está disponible en tu equipo.
- Nueva variable `SONORA_NO_GLASS=1` para apagar el cristal a mano, útil en máquinas virtuales o en escritorio remoto.

## Qué descargar

| Archivo | Para quién |
|---|---|
| **Sonora-1.0.1-win-x64.zip** | La opción recomendada. Trae todo lo necesario: solo descomprime y abre `Sonora.exe`. |
| **Sonora-1.0.1-win-x64-ligero.zip** | Más pequeño, pero necesitas tener instalado el [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0). |
| **SHA256SUMS.txt** | Huellas de los archivos, para comprobar que la descarga no se modificó. |

Requisitos: Windows 10 u 11 de 64 bits.

## Aviso al abrirlo

El programa no está firmado digitalmente, así que Windows puede mostrar «Windows protegió tu PC». Para abrirlo, pulsa **Más información → Ejecutar de todas formas**.
