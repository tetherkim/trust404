// Local demo/test resources only; do not use this to stop unrelated processes.
const stopping = new WeakMap();
export function stopProcess(child, graceMs = 1000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  const done = new Promise((resolve, reject) => {
    let forceTimer, deadline;
    const finish = error => {
      clearTimeout(forceTimer); clearTimeout(deadline);
      child.off('exit', onExit); child.off('error', onError);
      error ? reject(error) : resolve();
    };
    const onExit = () => finish();
    const onError = error => finish(error);
    child.once('exit', onExit); child.once('error', onError);
    forceTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    deadline = setTimeout(() => finish(new Error('LOCAL_PROCESS_STOP_TIMEOUT')), graceMs + 1000);
    child.kill('SIGTERM');
  });
  stopping.set(child, done);
  return done;
}

export async function closeHttpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}
