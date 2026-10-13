$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$taskImages=@()
foreach($taskSize in @(16,24,32,48,64,128,256)) {
  $taskBitmap=[Drawing.Bitmap]::new($taskSize,$taskSize)
  $taskGraphics=[Drawing.Graphics]::FromImage($taskBitmap)
  $taskGraphics.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $taskGraphics.Clear([Drawing.Color]::FromArgb(23,27,33))
  $taskPen=[Drawing.Pen]::new([Drawing.Color]::FromArgb(240,185,89),[Math]::Max(1,$taskSize/32))
  $taskGraphics.DrawRectangle($taskPen,$taskSize*.08,$taskSize*.08,$taskSize*.84,$taskSize*.84)
  $taskFont=[Drawing.Font]::new('Arial',[single]($taskSize*.34),[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel)
  $taskBrush=[Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(240,185,89))
  $taskFormat=[Drawing.StringFormat]::new()
  $taskFormat.Alignment=[Drawing.StringAlignment]::Center
  $taskFormat.LineAlignment=[Drawing.StringAlignment]::Center
  $taskGraphics.DrawString('TW',$taskFont,$taskBrush,[Drawing.RectangleF]::new(0,0,$taskSize,$taskSize),$taskFormat)
  $taskStream=[IO.MemoryStream]::new()
  $taskBitmap.Save($taskStream,[Drawing.Imaging.ImageFormat]::Png)
  $taskImages+=@{Size=$taskSize;Data=$taskStream.ToArray()}
  $taskStream.Dispose();$taskFormat.Dispose();$taskBrush.Dispose();$taskFont.Dispose();$taskPen.Dispose();$taskGraphics.Dispose();$taskBitmap.Dispose()
}
$taskIcon=[IO.File]::Create((Join-Path $PSScriptRoot 'icon.ico'))
$taskWriter=[IO.BinaryWriter]::new($taskIcon)
try {
  $taskWriter.Write([uint16]0);$taskWriter.Write([uint16]1);$taskWriter.Write([uint16]$taskImages.Count)
  $taskOffset=6+16*$taskImages.Count
  foreach($taskImage in $taskImages){$taskDimension=if($taskImage.Size -eq 256){0}else{$taskImage.Size};$taskWriter.Write([byte]$taskDimension);$taskWriter.Write([byte]$taskDimension);$taskWriter.Write([byte]0);$taskWriter.Write([byte]0);$taskWriter.Write([uint16]1);$taskWriter.Write([uint16]32);$taskWriter.Write([uint32]$taskImage.Data.Length);$taskWriter.Write([uint32]$taskOffset);$taskOffset+=$taskImage.Data.Length}
  foreach($taskImage in $taskImages){$taskWriter.Write([byte[]]$taskImage.Data)}
}finally{$taskWriter.Dispose();$taskIcon.Dispose()}
