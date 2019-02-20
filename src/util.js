// @ts-check
const path = require('path')
const fs = require('fs')
const util = require('util')
const { exec } = require('child_process')
const os = require('os')

const statAsync = util.promisify(fs.stat)

module.exports = {
  getId (fileDir, filePath) {
    return path
      .relative(fileDir, filePath)
      .replace(/\.[^/.]+$/, '')
      .replace(/\\+/g, '/')
      .toUpperCase()
  },

  async fileExists(destPath) {
    try {
      const stat = await statAsync(destPath)
      if (stat.isFile()) {
        return true
      }
    } catch (e) {
      // File not found
    }
    return false
  },

  /**
   * This function is highly inspired, if not blatantly copied from the systeminformation module by sebhildebrandt
   * Specifically, https://github.com/sebhildebrandt/systeminformation/blob/master/lib/filesystem.js#L40 has been
   * used.
   */
  fsSize() {
    return new Promise((resolve, reject) => {
      process.nextTick(() => {
        const data = []
        switch (process.platform) {
          case 'linux':
          case 'freebsd':
          case 'openbsd':
          case 'darwin':
            let cmd = ''
            if (process.platform === 'darwin') {
              cmd = 'df -lkP | grep ^/'
            }
            if (process.platform === 'linux') {
              cmd = 'df -lkPT | grep ^/'
            }
            if (process.platform === 'freebsd' || process.platform === 'openbsd') {
              cmd = 'df -lkPT'
            }
            exec(cmd, function (error, stdout) {
              if (!error) {
                let lines = stdout.toString().split('\n')
                lines.forEach(function (line) {
                  if (line !== '') {
                    let lineParts = line.replace(/ +/g, ' ').split(' ')
                    if ((lineParts && lineParts[0].startsWith('/'))
                      || (lineParts[6] && lineParts[6] === '/')) {
                      const res = {
                        fs: lineParts[0],
                        type: lineParts[1],
                        size: parseInt(lineParts[2]) * 1024,
                        used: parseInt(lineParts[3]) * 1024,
                        use: (100 * parseFloat(lineParts[3]) / parseFloat(lineParts[2])).toFixed(2),
                        mount: lineParts[lineParts.length - 1]
                      }
                      if (process.platform === 'darwin') {
                        res.type = 'HFS'
                        res.size = parseInt(lineParts[1]) * 1024
                        res.used = parseInt(lineParts[2]) * 1024
                      }
                      res.use = (100 * res.size / res.used).toFixed(2)
                      // data.push({
                      //   'fs': line[0],
                      //   'type': process.platform === 'darwin' ? 'HFS' : line[1],
                      //   'size': parseInt(process.platform === 'darwin' ?  line[1] : line[2]) * 1024,
                      //   'used': parseInt(process.platform === 'darwin' ? line[2] : line[3]) * 1024,
                      //   'use': parseFloat((100.0 * (process.platform === 'darwin' ? line[2] : line[3]) / (process.platform === 'darwin' ? line[1] : line[2])).toFixed(2)),
                      //   'mount': line[line.length - 1]
                      // })
                      data.push(res)
                    }
                  }
                })
              }
              resolve(data)
            })
            break
          case 'win32':
            try {
              // const wmic = os.type() === 'Windows_NT' && fs.existsSync(process.env.WINDIR + '\\system32\\wbem\\wmic.exe') ? wmic = process.env.WINDIR + '\\system32\\wbem\\wmic.exe' : 'wmic'
              exec('wmic logicaldisk get Caption,FileSystem,FreeSpace,Size', { windowsHide: true }, function (error, stdout) {
                if (error) {
                  reject(error)
                  return
                }
                let lines = stdout.split('\r\n').filter(line => line.trim() !== '').filter((line, idx) => idx > 0)
                lines.forEach(function (line) {
                  if (line !== '') {
                    let lineParts = line.trim().split(/\s\s+/)
                    data.push({
                      'fs': lineParts[0],
                      'type': lineParts[1],
                      'size': parseInt(lineParts[3]),
                      'used': parseInt(lineParts[3]) - parseInt(lineParts[2]),
                      'use': parseFloat((100.0 * (parseInt(lineParts[3]) - parseInt(lineParts[2])) / parseInt(lineParts[3])).toFixed(2)),
                      'mount': lineParts[0]
                    })
                  }
                })
                resolve(data)
              })
            } catch (e) {
              console.log(e)
              resolve(data)
            }
            break
        }
      })
    })
  }
}
