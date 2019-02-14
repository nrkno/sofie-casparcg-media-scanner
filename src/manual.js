const fs = require('fs')
const util = require('util')
let manualMode = false

const asyncWriteFile = util.promisify(fs.writeFile)
const asyncUnlink = util.promisify(fs.unlink)
const asyncStat = util.promisify(fs.stat)

module.exports = {
	getManualMode () {
		return manualMode
	},
	setManualMode (mode) {
		manualMode = !!mode

		if (manualMode) {
			asyncWriteFile('.manualMode', '', {}).then(() => { }).catch((e) => console.log(`Could not persist manual mode: ${mode}`))
		} else {
			asyncUnlink('.manualMode', '', {}).then(() => { }).catch((e) => console.log(`Could not persist manual mode: ${mode}`))
		}
	},
	restoreManualMode () {
		asyncStat('.manualMode').then(() => {
			manualMode = true
		}).catch(() => {
			manualMode = false
		})
	}
}
