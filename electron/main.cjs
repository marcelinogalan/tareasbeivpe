const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const SERVER_PORT = Number(process.env.ELECTRON_SERVER_PORT || 3210);
const HOST = "127.0.0.1";

let mainWindow = null;
let serverProcess = null;

function waitForServer(port, timeoutMs = 45_000) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect({ host: HOST, port }, () => {
        socket.end();
        resolve();
      });

      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Server did not become ready on ${HOST}:${port}`));
          return;
        }

        setTimeout(tryConnect, 300);
      });
    };

    tryConnect();
  });
}

function startServer() {
  if (serverProcess) return;

  const env = {
    ...process.env,
    PORT: String(SERVER_PORT),
    HOSTNAME: HOST,
    NODE_ENV: app.isPackaged ? "production" : "development"
  };

  if (app.isPackaged) {
    const serverScript = path.join(process.resourcesPath, "app-server", "server.js");
    serverProcess = spawn(process.execPath, [serverScript], {
      cwd: path.dirname(serverScript),
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1"
      },
      stdio: "inherit"
    });
  } else {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    serverProcess = spawn(cmd, ["run", "dev", "--", "--hostname", HOST, "--port", String(SERVER_PORT)], {
      cwd: app.getAppPath(),
      env,
      stdio: "inherit"
    });
  }

  serverProcess.on("exit", (code) => {
    serverProcess = null;
    if (!app.isQuitting) {
      dialog.showErrorBox(
        "Servidor detenido",
        `El servidor interno se cerró (codigo ${code ?? "desconocido"}).`
      );
      app.quit();
    }
  });
}

function stopServer() {
  if (!serverProcess) return;

  const child = serverProcess;
  serverProcess = null;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"]);
    return;
  }

  child.kill("SIGTERM");
}

async function createWindow() {
  startServer();
  await waitForServer(SERVER_PORT);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  await mainWindow.loadURL(`http://${HOST}:${SERVER_PORT}`);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("before-quit", () => {
  app.isQuitting = true;
  stopServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (mainWindow) return;
  try {
    await createWindow();
  } catch (error) {
    dialog.showErrorBox("Error de inicio", String(error));
    app.quit();
  }
});

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
    dialog.showErrorBox("Error de inicio", String(error));
    app.quit();
  }
});
