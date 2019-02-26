function killChildProcessWin32 (childProcess) {
  ChildProcess.spawn("taskkill", ["/pid", childProcess.pid, '/f', '/t']);
}

function crossPlatformKillProcessIfValid(childProcess) {
  if(!childProcess || !childProcess.pid) {
    return
  }
  switch (process.platform) {
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'darwin':
      childProcess.kill()
    case 'win32':
      killChildProcessWin32(childProcess)
  }
}

module.exports = {
  crossPlatformKillProcessIfValid
}
