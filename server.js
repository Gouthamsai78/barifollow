import { createServer } from "./src/app.js";
import { startSyncLoop } from "./src/orders.js";

const port = Number(process.env.PORT || 3000);
const server = createServer();

startSyncLoop();

server.listen(port, () => {
  const actual = server.address();
  const shown = actual && typeof actual === "object" ? actual.port : port;
  console.log(`BariFollow listening on http://localhost:${shown}`);
  console.log(`Store: http://localhost:${shown}/store · Admin: http://localhost:${shown}/store/admin`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
