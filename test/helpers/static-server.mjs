import { createStaticServer } from "../../scripts/dev-server.mjs";

export function startStaticServer() {
  const server = createStaticServer();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((closed) => server.close(closed))
      });
    });
  });
}
