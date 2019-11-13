const find = require('find');
const os = require('os')
const path = require('path')
const fs = require('fs-extra')

const arch = os.arch()
const platform = os.platform()
const prebuildType = process.argv[2] || `${platform}-${arch}`

function isFileForPlatform(filename) {
    if (filename.indexOf(path.join('prebuilds', prebuildType)) !== -1) {
        return true
    } else {
        return false
    }
}

console.log('Running in', __dirname, 'for', prebuildType)

console.log(process.argv[2])

find.file(/\.node$/, path.join(__dirname, 'node_modules'), (files) => {
    files.forEach(fullPath => {
        if (fullPath.indexOf(__dirname) === 0) {
            const file = fullPath.substr(__dirname.length + 1)
            if (isFileForPlatform(file)) {
                console.log('copy prebuild binary:', file)
                fs.copySync(file, path.join('deploy', file))
            }
        }
    });
})
