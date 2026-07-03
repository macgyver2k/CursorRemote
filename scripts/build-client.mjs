import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import "./build-highlight.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientOut = join(root, "dist", "client");
const socketBase = join(root, "node_modules", "socket.io", "client-dist");

mkdirSync(join(root, "dist"), { recursive: true });
rmSync(clientOut, { recursive: true, force: true });
cpSync(join(root, "src", "client"), clientOut, { recursive: true });
cpSync(
  join(socketBase, "socket.io.min.js"),
  join(clientOut, "vendor-socket.io.min.js"),
);
cpSync(
  join(socketBase, "socket.io.min.js.map"),
  join(clientOut, "vendor-socket.io.min.js.map"),
);
const highlightVendor = join(root, "src", "client", "vendor-highlight.min.js");
if (existsSync(highlightVendor)) {
  cpSync(highlightVendor, join(clientOut, "vendor-highlight.min.js"));
}
