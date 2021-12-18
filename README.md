# bt-fetch
Interact with Bittorrent the same way you would websites via fetch() and `bittorrent://` URLs

## How it works

- Uses WebTorrent to load torrents
- `bt://` URLs put the `infohash` of a torrent into the `hostname` portion
- `bt://` URLs can contain an individual file to prioritize downloading
- `bt://` URLs can point to a path

## API

```JavaScript
const fetch = require('bt-fetch')({
  // Use this if you want things to be downloaded somewhere specific
  storageLocation: '~/.local/data/bt-fetch/'
  // You can also pass any arguments from `new WebTorrent` and `client.add`
})

// Get a file as text
const res = fetch('bittorrent://08ada5a7a6183aae1e09d831df6748d566095a10/example.html')

const cotent = await res.text()

// How big is the file in bytes (useful in HEAD requests)
const length = res.headers.get('Content-Length')
// How much of the file has been downloaded in bytes
const downloaded = res.headers.get('X-Downloaded')

// List files / subfolders as JSON
const res = await fetch('bittorrent://infohash/path/')

const files = await res.json()

// List the contents as a web page
const res = await fetch('bittorrent://infohash/path/', {headers: {
  Accept: 'text/html'
})

const page = await res.text()

// now also supports public keys bittorrent://64CharacterPublicKeyHere
const pubRes = fetch('bittorrent://1e267e045c1abcb9af26df782a048a1cfd2d26e6db23ff5026b213ce037301bf')
```

## TODO

- Pass querystring params from magnet link info (trackers, etc)
- Support `index.html` resolution (with opt-out)
- Creating torrents using POST
- Mutable torrents (GET / POST)
- Mutable torrent record exchange (updates without DHT polling)
- Figure out what to do about Magnet Links
- Support some sort of DNS?
