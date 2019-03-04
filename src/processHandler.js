const ChildProcess = require('child_process')

function killChildProcessWin32 (childProcess) {
  return new Promise((resolve, reject) => {
    let killTask = ChildProcess.spawn('taskkill', ['/pid', childProcess.pid, '/f', '/t'])
    killTask.on('exit', () => {
      resolve()
    })
  })
}

async function crossPlatformKillProcessIfValid (childProcess) {
  if (!childProcess || !childProcess.pid) {
    return
  }
  switch (process.platform) {
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'darwin':
      console.log('Killing process with pid ' + childProcess.pid)
      // TODO: this will likely not work on *nix (it is a process tree)
      // consider using something like tree-kill: https://github.com/pkrumins/node-tree-kill
      return childProcess.kill()
    case 'win32':
      console.log('Killing win32 process with pid ' + childProcess.pid)
      return killChildProcessWin32(childProcess)
  }
}

module.exports = {
  crossPlatformKillProcessIfValid
}
