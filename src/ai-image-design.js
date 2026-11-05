// OpenAI-backed image design adaptation for original visual assets.
export async function reviseDesignImage(imageBuffer, instruction) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
  const form = new FormData();
  form.append('model', process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst');
  form.append('image', new Blob([imageBuffer], { type: 'image/png' }), 'design.png');
  form.append('prompt', instruction);
  form.append('size', '1024x1024');
  form.append('quality','high');
  form.append('output_format','png');
  const response = await fetch('https://api.openai.com/v1/images/edits', { method:'POST', headers: { Authorization: 'Bearer '+process.env.OPENAI_API_KEY }, body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || 'Image API failed');
  if (!body.data?.[0]?.b64_json) throw new Error('No image returned');
  return Buffer.from(body.data[0].b64_json, 'base64');
}

export async function reviseDesignRegion(sourceBuffer, rect, instruction) {
  const sharp = (await import('sharp')).default;
  const original = await sharp(sourceBuffer).rotate().png().toBuffer();
  const meta = await sharp(original).metadata();
  const {x,y,w,h} = rect;
  if (![x,y,w,h].every(Number.isInteger) || x<0 || y<0 || w<4 || h<4 ||
      x+w>meta.width || y+h>meta.height) throw new Error('수정 영역을 다시 선택해 주세요.');
  const margin=Math.max(20,Math.ceil(Math.max(w,h)*0.8));
  const left=Math.max(0,x-margin),top=Math.max(0,y-margin);
  const right=Math.min(meta.width,x+w+margin),bottom=Math.min(meta.height,y+h+margin);
  const cw=right-left,ch=bottom-top;
  const context=await sharp(original).extract({left,top,width:cw,height:ch}).resize(1024,1024,{fit:'fill'}).png().toBuffer();
  const generated=await reviseDesignImage(context, instruction+' Preserve the surrounding visual context, and keep the framing exactly the same.');
  const resized=await sharp(generated).resize(cw,ch,{fit:'fill'}).png().toBuffer();
  const patch=await sharp(resized).extract({left:x-left,top:y-top,width:w,height:h}).png().toBuffer();
  return sharp(original).composite([{input:patch,left:x,top:y}]).png().toBuffer();
}
