import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';

const output = await build({
  configFile: false,
  build: {
    write: false, target: 'es2022', minify: true,
    lib: { entry: 'web/preview.ts', name: 'SchoolModelPreview', formats: ['iife'] }
  }
});
const assets = (Array.isArray(output) ? output : [output]).flatMap(part => part.output);
const code = assets.find(asset => asset.type === 'chunk').code;
const style = assets.filter(asset => asset.type === 'asset' && asset.fileName.endsWith('.css')).map(asset => asset.source).join('\n');
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>D-GPT 모델 선택 미리보기</title>
<style>
body{margin:0;min-height:100dvh;background:#08080d;color:#f3f4f8;font:16px/1.5 "Segoe UI","Malgun Gothic",sans-serif}
header.preview-bar{display:flex;align-items:center;gap:1rem;padding:.5rem 1rem;border-bottom:1px solid #ffffff15}
.preview-brand{font-size:.88rem;font-weight:700}
#open{display:flex;align-items:center;gap:.5rem;padding:.5rem .7rem;border:0;border-radius:.6rem;color:#f3f4f8;background:transparent;font:inherit;font-size:.93rem;font-weight:650;cursor:pointer}
#open:hover,#open[aria-expanded="true"]{background:#ffffff14}
#open:focus-visible{outline:2px solid #d5c9ff}
.preview-gauge{position:relative;width:.85rem;height:.85rem;border:2px solid #cdc1ff;border-radius:50%;transition:transform .32s ease-out}
.preview-gauge::before{content:'';position:absolute;left:calc(50% - 1px);top:1px;width:2px;height:45%;border-radius:2px;background:#cdc1ff}
main{max-width:35rem;margin:clamp(4rem,22vh,15rem) auto 0;padding:0 1.25rem;text-align:center}
h1{margin:0;font-size:clamp(1.6rem,5vw,2.5rem);letter-spacing:-.045em}
p{color:#a5a6ba}
@media(prefers-reduced-motion:reduce){.preview-gauge{transition:none}}
${style}</style></head>
<body><header class="preview-bar"><span class="preview-brand">D-GPT</span><button type="button" id="open" aria-haspopup="dialog" aria-expanded="false" aria-label="모델 선택 열기"><span class="preview-gauge" aria-hidden="true"></span><span id="chosen"></span></button></header>
<main><h1>모델 선택 미리보기</h1><p>왼쪽 위 모델 이름을 누르면 다이얼이 열립니다. 모델 목록과 이미지 지원 표시는 예시입니다.</p></main><script>${code.replaceAll('</script', '<\\/script')}</script></body></html>`;
const dir = '.codex-work/dgpt-desktop';
await mkdir(dir, { recursive: true });
await writeFile(dir + '/model-preview.html', html);
