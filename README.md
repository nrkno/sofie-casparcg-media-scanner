Sofie: The Modern TV News Studio Automation System (CasparCG Media Scanner)
===============
Sofie-specific fork of CasparCG Server 2.2's Media Scanner, modified to work with the [Sofie-specific fork of CasparCG Server](https://github.com/nrkno/tv-automation-casparcg-server) where most new features have been contributed back to the official branch.

This project facilitates CasparCG Server since version 2.2.0. It abstracts the collection of metadata and generation of thumbnails into a separate process.

Usage
-----

This project is designed to be used via the AMCP protocol in CasparCG server. However, there are some endpoints for additional data which can only be access directly over http.

### Configuration
There are various options that can be changed for the scanner. These can all be set by environment variables or as arguments.
Some features are disabled by default and should be enabled in this way.

To change options with arguments use the following syntax: `scanner.exe --metadata.scenes true --metadata.sceneThreshold 0.5`

The full set of available options and their default values can be found at [config.js](src/config.js)

By default the scanner expects there to be a casparcg.config file next to the executable to specify the paths to media. To disable use of this file `scanner.exe --caspar null`

### AMCP Endpoints
These endpoints are exposed by the AMCP protocol in CasparCG Server. This means that they have some AMCP syntax wrappings, which will likely need to be stripped off if using in an external client

* `/tls` - Lists available template files
* `/cls` - Lists available media files
* `/fls` - Lists available font files
* `/cinf/<name>` - Gets information on specified media file
* `/media/scan/<name>` - Scans the specific file, can be used in tandem with manual mode
* `/thumbnail/generate` - Generates thumbnails for all media
* `/thumbnail/generate/<name>` - Generates a thumbnail for the specific file
* `/thumbnail` - Lists the available thumbnails
* `/thumbnail/<name>` - Gets the thumbnail for a media file
* `/preview/generate/<name>` - Generates a webm preview for the specific file
* `/stat/fs` - Gets statistics about disk size, format and usage
* `/stat/seq` - Gets the sequence number from PouchDB, it starts at 0 and gets incremented every time a document is added or modified.
* `/manualMode/<enabled>` - Sets the mode of the scanner, in manual mode API requests have to be mode in order to scan media.

### Changes
A stream of changes can be accessed with the following. [Full docs](https://pouchdb.com/api.html#changes)
```
const PouchDB = require('pouchdb-node')
const db = new PouchDB('http://localhost:8000/db/_media')

// Listen for changes
db.changes({
    since: 'now',
    include_docs: true,
    live: true
}).on('change', function (changes) {
    console.log(changes)
}).on('error', function (err) {
    // handle errors
});
```

### Enhanced Metadata
These endpoints provide additional metadata on media in a json format. Depending on your configuration this will include field order, cut / scene detection and black frame detection.

* `/media` - Lists available media files in json form with an enhanced set of metadata
* `/media/info/<name>` - Gets the json enhanced metadata for the specified media file
* `/media/thumbnail/<name>` - Gets the thumbnail for a media file

### Preview Videos
This tool is able to generate low resolution webm preview videos of all media, intended to be used in web based clients.
They are generated in the background after the media is found or detected to have changed, so may not be available immediately.
They can be accessed via the following url format `/media/preview/<name>`

Development
-----------

This project uses the LTS version NodeJS (12), so you need that installed. Get it from: https://nodejs.org/en/. 
We also use Leveldown which uses native modules so if you're on Windows you need to install windows build tools:

`npm install --global --production windows-build-tools`

After this:
* Clone the repository
* Run `yarn install`
* Run `yarn dev` to start the development server

Building
-----------
Be aware that because of the native extensions, you can only build for the target you are currently on.

* On Windows
  * `yarn build-win32`
* On Linux
  * `yarn build-linux`
  
The built files will be placed in `./deploy`, make sure you copy all files into the main CasparCG directory.

License
-------

CasparCG Media-Scanner is distributed under the GNU Lesser General Public License LGPLv3 or
higher, see [LICENSE](LICENSE) for details.

More information is available at http://casparcg.com/


Documentation
-------------

The most up-to-date documentation is always available at
https://github.com/CasparCG/help/wiki
