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
