# Draws LANTern's two Android launcher icons and the TV banner, and writes
# them into the Android project's resources.
#
#   phone  ic_launcher*      the lantern with the network triangle, on charcoal
#   TV     ic_launcher_tv*   the same lantern with a play button, on navy
#   both   *_monochrome      the one-colour layer Android 13 tints for themed icons
#   TV     tv_banner         the lantern, "LANTV" and a line under it
#
# The mark is the one in assets/brand/lantern-*.svg (made in Claude Design);
# the geometry below is those paths, centred on (0, 0) in a 1024 box scaled by
# 0.95, so a change to the logo is a change to the numbers in Draw-Lantern.
#
# Both builds used to ship the Tauri template's launcher icon, because
# `tauri android init` writes it and nothing ever replaced it. The manifest
# picks the icon through the ${appIcon} placeholder (app/build.gradle.kts), so
# the two packages differ without a second resource tree.
#
# Run from anywhere:  powershell -File scripts\make-android-icons.ps1
# Drawn with GDI+ so there is no dependency to install; re-running overwrites.

Add-Type -AssemblyName System.Drawing

$res = Join-Path $PSScriptRoot '..\src-tauri\gen\android\app\src\main\res' | Resolve-Path

$gold = [System.Drawing.Color]::FromArgb(255, 245, 166, 35)
$goldLight = [System.Drawing.Color]::FromArgb(255, 255, 210, 127)
$goldWash = [System.Drawing.Color]::FromArgb(36, 245, 166, 35)   # 14% of the gold
$white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

# The mark spans -324 .. 324 vertically (the stem's top to the base's bottom,
# strokes included), so this many units are one `h`.
$spanUnits = 648.0

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  return @{ Bitmap = $bmp; G = $g }
}

# A quadratic curve as the cubic GDI+ draws: both control points sit two
# thirds of the way from an end to the quadratic's one.
function Add-Quad($path, $p0, $q, $p2) {
  $c1 = New-Object System.Drawing.PointF(($p0.X + 2.0 / 3 * ($q.X - $p0.X)), ($p0.Y + 2.0 / 3 * ($q.Y - $p0.Y)))
  $c2 = New-Object System.Drawing.PointF(($p2.X + 2.0 / 3 * ($q.X - $p2.X)), ($p2.Y + 2.0 / 3 * ($q.Y - $p2.Y)))
  $path.AddBezier($p0, $c1, $c2, $p2)
}

# Draws the lantern with its middle at (cx, cy), `h` pixels tall.
#   glyph  'nodes' the network triangle, 'play' a play button
#   mono   draw everything in white (the themed-icon layer)
function Draw-Lantern($g, [double]$cx, [double]$cy, [double]$h, [string]$glyph, [bool]$mono = $false) {
  $k = $h / $spanUnits
  # Typed, because an untyped `& $P -116 -200` reads -116 as a parameter name and
  # every point with a negative coordinate came out at the centre.
  $P = { param([double]$x, [double]$y) New-Object System.Drawing.PointF([single]($cx + $x * $k), [single]($cy + $y * $k)) }
  $line = if ($mono) { $white } else { $gold }
  $dot = if ($mono) { $white } else { $goldLight }

  $pen = New-Object System.Drawing.Pen($line, [single](48 * $k))
  $pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'

  # The body: a tapered lantern with soft corners.
  $body = New-Object System.Drawing.Drawing2D.GraphicsPath
  $body.AddLine((& $P -116 -200), (& $P 116 -200))
  Add-Quad $body (& $P 116 -200) (& $P 160 -200) (& $P 163.9 -156.2)
  $body.AddLine((& $P 163.9 -156.2), (& $P 196.1 206.2))
  Add-Quad $body (& $P 196.1 206.2) (& $P 200 250) (& $P 156 250)
  $body.AddLine((& $P 156 250), (& $P -156 250))
  Add-Quad $body (& $P -156 250) (& $P -200 250) (& $P -196.1 206.2)
  $body.AddLine((& $P -196.1 206.2), (& $P -163.9 -156.2))
  Add-Quad $body (& $P -163.9 -156.2) (& $P -160 -200) (& $P -116 -200)
  $body.CloseFigure()
  if (-not $mono) { $g.FillPath((New-Object System.Drawing.SolidBrush($goldWash)), $body) }
  $g.DrawPath($pen, $body)

  # The handle, the cap's crossbar and the base.
  $g.DrawLine($pen, (& $P 0 -300), (& $P 0 -252))
  $g.DrawLine($pen, (& $P -92 -252), (& $P 92 -252))
  $g.DrawLine($pen, (& $P -120 300), (& $P 120 300))

  if ($glyph -eq 'play') {
    # A play button where the network was: this is the television one.
    $fill = New-Object System.Drawing.SolidBrush($white)
    $tri = [System.Drawing.PointF[]]@((& $P -50 -62), (& $P -50 132), (& $P 82 35))
    $g.FillPolygon($fill, $tri)
    $edge = New-Object System.Drawing.Pen($white, [single](22 * $k))
    $edge.LineJoin = 'Round'
    $g.DrawPolygon($edge, $tri)
  } else {
    # The network: three devices and the links between them.
    $link = New-Object System.Drawing.Pen($line, [single](26 * $k))
    $link.LineJoin = 'Round'
    $g.DrawPolygon($link, [System.Drawing.PointF[]]@((& $P 0 -55), (& $P -92 125), (& $P 92 125)))
    $solid = New-Object System.Drawing.SolidBrush($line)
    $light = New-Object System.Drawing.SolidBrush($dot)
    foreach ($n in @(@(-92, 125, 40), @(92, 125, 40))) {
      $c = & $P $n[0] $n[1]; $r = $n[2] * $k
      $g.FillEllipse($solid, [single]($c.X - $r), [single]($c.Y - $r), [single](2 * $r), [single](2 * $r))
    }
    $c = & $P 0 -55; $r = 44 * $k
    $g.FillEllipse($light, [single]($c.X - $r), [single]($c.Y - $r), [single](2 * $r), [single](2 * $r))
  }
}

function Fill-Background($g, [int]$w, [int]$h, [string]$kind) {
  if ($kind -eq 'tv') {
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $b = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $rect,
      [System.Drawing.Color]::FromArgb(255, 22, 40, 70),
      [System.Drawing.Color]::FromArgb(255, 7, 11, 22), 55.0)
    $g.FillRectangle($b, $rect)
  } else {
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 11, 13, 16))
    $g.FillRectangle($b, 0, 0, $w, $h)
  }
}

function Save-Png($canvas, [string]$path) {
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  $canvas.Bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.G.Dispose(); $canvas.Bitmap.Dispose()
}

# Legacy launcher icons (before adaptive icons, and for round launchers).
function Launcher([int]$size, [string]$kind, [string]$shape, [string]$glyph) {
  $c = New-Canvas $size $size
  $g = $c.G
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($shape -eq 'round') {
    $path.AddEllipse(0, 0, $size, $size)
  } else {
    $r = $size * 0.22
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
  }
  $g.SetClip($path)
  Fill-Background $g $size $size $kind
  $g.ResetClip()
  # 62% of the icon: the same share the master artwork gives the lantern.
  Draw-Lantern $g ($size / 2) ($size / 2) ($size * 0.62) $glyph
  return $c
}

# The adaptive icon's foreground: 108dp, with the mark inside the 66dp that
# every launcher mask keeps. The mask is a circle, so what has to fit is the
# farthest corner of the mark - the base's ends - not its height: at 60% they
# poked out of the circle, at 54% they sit inside it.
function Foreground([int]$size, [string]$glyph, [bool]$mono) {
  $c = New-Canvas $size $size
  Draw-Lantern $c.G ($size / 2) ($size / 2) ($size * 0.54) $glyph $mono
  return $c
}

$density = [ordered]@{ mdpi = 1.0; hdpi = 1.5; xhdpi = 2.0; xxhdpi = 3.0; xxxhdpi = 4.0 }
foreach ($name in $density.Keys) {
  $f = $density[$name]
  $dir = Join-Path $res "mipmap-$name"
  $legacy = [int](48 * $f)
  $fore = [int](108 * $f)

  Save-Png (Launcher $legacy 'phone' 'square' 'nodes') (Join-Path $dir 'ic_launcher.png')
  Save-Png (Launcher $legacy 'phone' 'round' 'nodes') (Join-Path $dir 'ic_launcher_round.png')
  Save-Png (Foreground $fore 'nodes' $false) (Join-Path $dir 'ic_launcher_foreground.png')
  Save-Png (Foreground $fore 'nodes' $true) (Join-Path $dir 'ic_launcher_monochrome.png')

  Save-Png (Launcher $legacy 'tv' 'square' 'play') (Join-Path $dir 'ic_launcher_tv.png')
  Save-Png (Launcher $legacy 'tv' 'round' 'play') (Join-Path $dir 'ic_launcher_tv_round.png')
  Save-Png (Foreground $fore 'play' $false) (Join-Path $dir 'ic_launcher_tv_foreground.png')
  Save-Png (Foreground $fore 'play' $true) (Join-Path $dir 'ic_launcher_tv_monochrome.png')
}

# The television launcher's banner: 320 x 180 dp, drawn at xhdpi (640 x 360)
# so it stays sharp on a 4K set.
$bw = 640; $bh = 360
$c = New-Canvas $bw $bh
Fill-Background $c.G $bw $bh 'tv'
Draw-Lantern $c.G 150 ($bh / 2) 262 'play'
$titleFont = New-Object System.Drawing.Font('Segoe UI', 92, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subFont = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$c.G.DrawString('LANTV', $titleFont, [System.Drawing.Brushes]::White, 262, 110)
$c.G.DrawString('Theatre on your network', $subFont,
  (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 190, 200, 220))), 268, 214)
Save-Png $c (Join-Path $res 'drawable-xhdpi\tv_banner.png')

Write-Host 'icons written'
