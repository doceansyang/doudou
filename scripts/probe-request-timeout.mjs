import http from "node:http";

async function test(label, setValue, sleepMs) {
  const server = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); }, sleepMs);
  });
  server.requestTimeout = setValue;
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const started = Date.now();
  let result;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(sleepMs + 15000) });
    result = `status=${res.status} body=${await res.text()}`;
  } catch (e) { result = `ERROR ${e.name}: ${e.message}`; }
  console.log(`${label} | requestTimeout=${setValue} sleep=${sleepMs}ms => ${result} (${((Date.now()-started)/1000).toFixed(1)}s)`);
  server.close();
}

await test("A", 300000, 8000);
await test("B", 3000, 8000);
await test("C", 0, 8000);
