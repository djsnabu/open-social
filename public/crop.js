export function cropRect(width, height, ratio, zoom, x, y) {
  const w = Math.min(width, height * ratio) / zoom;
  const h = w / ratio;
  return { x: (width - w) * x, y: (height - h) * y, width: w, height: h };
}

export async function cropImage(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error('Kuvan enimmäiskoko on 8 Mt.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Valitse JPEG-, PNG- tai WebP-kuva.');
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('Kuvaa ei voitu avata. Valitse toinen kuva.'); }
  if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); throw new Error('Kuvan enimmäiskoko on 40 megapikseliä.'); }
  const $ = id => document.getElementById(`crop-${id}`);
  const dialog = $('dialog'), canvas = $('preview'), context = canvas.getContext('2d');
  const ratio = $('ratio'), zoom = $('zoom'), x = $('x'), y = $('y');
  ratio.value = bitmap.width < bitmap.height ? '0.8' : bitmap.width > bitmap.height ? '1.91' : '1';
  $('apply').disabled = false;
  zoom.value = '1'; x.value = y.value = '0.5'; $('error').hidden = true;
  const rect = () => cropRect(bitmap.width, bitmap.height, +ratio.value, +zoom.value, +x.value, +y.value);
  function draw() {
    canvas.width = 480; canvas.height = Math.round(480 / +ratio.value);
    const r = rect();
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, canvas.width, canvas.height);
  }
  for (const control of [ratio, zoom, x, y]) control.oninput = draw;
  let drag;
  canvas.onpointerdown = event => { drag = { x: event.clientX, y: event.clientY, px: +x.value, py: +y.value }; canvas.setPointerCapture(event.pointerId); };
  canvas.onpointermove = event => {
    if (!drag) return;
    const r = rect(), bounds = canvas.getBoundingClientRect();
    if (bitmap.width > r.width) x.value = Math.max(0, Math.min(1, drag.px - (event.clientX - drag.x) * r.width / bounds.width / (bitmap.width - r.width)));
    if (bitmap.height > r.height) y.value = Math.max(0, Math.min(1, drag.py - (event.clientY - drag.y) * r.height / bounds.height / (bitmap.height - r.height)));
    draw();
  };
  canvas.onpointerup = canvas.onpointercancel = () => { drag = null; };
  draw();
  try {
    return await new Promise(resolve => {
      let result = null, closed = false;
      dialog.onclose = () => { closed = true; resolve(result); };
      $('cancel').onclick = () => dialog.close();
      $('original').onclick = () => { result = file; dialog.close(); };
      $('apply').onclick = () => {
        const output = document.createElement('canvas');
        [output.width, output.height] = ratio.value === '0.8' ? [1080, 1350] : ratio.value === '1' ? [1080, 1080] : [1337, 700];
        const ctx = output.getContext('2d'), r = rect();
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, output.width, output.height);
        ctx.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, output.width, output.height);
        $('apply').disabled = true;
        output.toBlob(blob => {
          if (closed || !dialog.open) return;
          $('apply').disabled = false;
          if (!blob) { $('error').textContent = 'Rajauksen tallentaminen epäonnistui. Yritä uudelleen.'; $('error').hidden = false; return; }
          result = blob; dialog.close();
        }, 'image/jpeg', 0.92);
      };
      dialog.showModal();
    });
  } finally { bitmap.close(); }
}
