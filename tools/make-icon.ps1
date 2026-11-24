# Genera assets\sonora.ico con el logo actual (vinilo minimalista) en varios tamaños (PNG dentro del ICO).
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'assets\sonora.ico'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

function New-LogoPng([int]$s) {
    $bmp = New-Object Drawing.Bitmap $s, $s, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'; $g.Clear([Drawing.Color]::Transparent)
    # Fondo tipo squircle grafito (se ve bien sobre escritorios claros y oscuros)
    $r = [Math]::Max(2, $s * 0.23); $pad = [Math]::Max(0, [int]($s * 0.04)); $w = $s - 2 * $pad
    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $path.AddArc($pad, $pad, $d, $d, 180, 90); $path.AddArc($pad + $w - $d, $pad, $d, $d, 270, 90)
    $path.AddArc($pad + $w - $d, $pad + $w - $d, $d, $d, 0, 90); $path.AddArc($pad, $pad + $w - $d, $d, $d, 90, 90); $path.CloseFigure()
    $bg = New-Object Drawing.Drawing2D.LinearGradientBrush ([Drawing.Rectangle]::new(0, 0, $s, $s)), ([Drawing.Color]::FromArgb(255, 46, 46, 52)), ([Drawing.Color]::FromArgb(255, 16, 16, 19)), 90
    $g.FillPath($bg, $path)
    $hl = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(60, 255, 255, 255)), ([Math]::Max(1, $s / 128))
    $g.DrawPath($hl, $path)
    # Logo: aro exterior, aro interior tenue y centro (mismas proporciones que el SVG 24x24)
    $k = $w / 24.0 * 0.78; $c = $s / 2.0
    $white = [Drawing.Color]::FromArgb(255, 245, 245, 247)
    $p1 = New-Object Drawing.Pen $white, ([Math]::Max(1.2, 1.6 * $k)); $R1 = 9.6 * $k
    $g.DrawEllipse($p1, [float]($c - $R1), [float]($c - $R1), [float](2 * $R1), [float](2 * $R1))
    if ($s -ge 32) {
        $p2 = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(115, 245, 245, 247)), ([Math]::Max(1, 1.0 * $k)); $R2 = 5.6 * $k
        $g.DrawEllipse($p2, [float]($c - $R2), [float]($c - $R2), [float](2 * $R2), [float](2 * $R2))
    }
    $R3 = [Math]::Max(1.5, 2.4 * $k)
    $g.FillEllipse((New-Object Drawing.SolidBrush $white), [float]($c - $R3), [float]($c - $R3), [float](2 * $R3), [float](2 * $R3))
    $g.Dispose()
    $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    return , $ms.ToArray()
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$pngs = $sizes | ForEach-Object { , (New-LogoPng $_) }
$fs = [IO.File]::Create($out); $bw = New-Object IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $len = $pngs[$i].Length
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$len); $bw.Write([UInt32]$offset); $offset += $len
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Close()
# Vista previa
[IO.File]::WriteAllBytes((Join-Path $root 'assets\sonora-256.png'), $pngs[-1])
"Icono creado: $out"
