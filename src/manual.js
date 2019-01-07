let manualMode = false

module.exports = {
	getManualMode () {
		return manualMode
	},
	setManualMode (mode) {
		manualMode = !!mode
	}
}
