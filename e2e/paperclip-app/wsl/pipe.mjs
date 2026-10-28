// Byte relay: stdin/stdout <-> 127.0.0.1:8560 inside WSL. No HTTP parsing or rewriting.
import net from "node:net";
const s = net.connect(8560, "127.0.0.1");
process.stdin.pipe(s);
s.pipe(process.stdout);
s.on("close", () => process.exit(0));
s.on("error", () => process.exit(1));
