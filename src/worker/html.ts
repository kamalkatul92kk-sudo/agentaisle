export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1f2937}h1{font-size:22px}.card{border:1px solid #e5e7eb;border-radius:12px;padding:20px}.mock{background:#fff7ed;border:1px solid #fdba74;padding:8px 12px;border-radius:8px;font-size:13px}button{font-size:15px;padding:10px 18px;border-radius:8px;border:0;margin-right:8px;cursor:pointer}.yes{background:#0070ba;color:#fff}.no{background:#e5e7eb}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;word-break:break-all}</style></head>
<body>${body}<p class="demo-note" style="font-size:12px;color:#6b7280;margin-top:24px">AgentAisle hackathon demo · fictional merchant in Texas · PayPal <b>sandbox</b> only, no real money moves.</p></body></html>`;
}
