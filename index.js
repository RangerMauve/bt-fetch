const makeFetch = require('make-fetch')
const WebTorrent = require('webtorrent')
const {WebProperty, verify} = require('webproperty/lookup.js')
const mime = require('mime/lite')
const nodeStreamToIterator = require('stream-async-iterator')
const parseRange = require('range-parser')

module.exports = makeBTFetch

// 30 seconds to get a torrent takes a while. 😅
const DEFAULT_TIMEOUT = 30 * 1000
const INFO_HASH_MATCH = /^[a-f0-9]{40}$/ig

function makeBTFetch ({
  storageLocation,
  loadTimeout = DEFAULT_TIMEOUT,
  ...opts
} = {}) {
  if(opts.dht){
    opts.dht.verify = verify
  } else {
    opts.dht = {verify}
  }
  const client = new WebTorrent(opts)
  const domain = new WebProperty({dht: client.dht, check: false})

  // Promises for torrents currently being loaded
  const getting = new Map()
  // Map of infoHash to torrent
  const torrents = new Map()

  async function getTorrent (infoHash) {
    if (torrents.has(infoHash)) return torrents.get(infoHash)
    if (getting.has(infoHash)) return getting.get(infoHash)

    const promise = Promise.race([
      new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`Timed out: ${infoHash} after ${loadTimeout}ms`))
        }, loadTimeout)
      }),
      new Promise((resolve, reject) => {
        const finalOpts = { ...opts }
        const torrentInfo = {
          infoHash,
          // Disable loading any files on start
          // https://github.com/webtorrent/webtorrent/issues/164#issuecomment-703489174
          so: '-1'
        }
        if (storageLocation) finalOpts.path = storageLocation + infoHash
        client.add(torrentInfo, finalOpts, (torrent) => {
          resolve(torrent)
        })
      })
    ])

    getting.set(infoHash, promise)

    try {
      const torrent = await promise
      torrents.set(infoHash, torrent)

      // Load data sparsely by default
      torrent.files.forEach(file => file.deselect())
      torrent.deselect(0, torrent.pieces.length - 1, false)

      return torrent
    } finally {
      getting.delete(infoHash)
    }
  }

  async function getFile (infoHash, filePath) {
    const torrent = await getTorrent(infoHash)

    return torrent.files.find(({ path }) => path === filePath)
  }

  async function getDirectoryFiles (infoHash, directoryPath) {
    const torrent = await getTorrent(infoHash)

    return torrent.files.filter(({ path }) => path.startsWith(directoryPath))
  }

  const fetch = makeFetch(async (request) => {
    const {
      url,
      method,
      headers: reqHeaders
    } = request
    try {
      const {
        hostname,
        pathname,
        protocol
      } = new URL(url)
      if (protocol !== 'bittorrent:') {
        throw new Error('Invalid protocol, must be `bittorrent:`')
      }
      let infoHash = hostname
      let path = pathname.slice(1)

      const headers = {}

      if (!infoHash) {
      // Pathname must look like `
        const parts = pathname.slice(2).split('/')
        infoHash = parts[0]
        path = parts.slice(1).join('/')
      }

      if(infoHash && infoHash.length === 64){
        infoHash = await new Promise((resolve, reject) => {
          domain.resolve(infoHash, (error, data) => {
            if(error){
              reject(null)
            } else {
              resolve(data.infoHash)
            }
          })
        })
      }

      if (!infoHash || !infoHash.match(INFO_HASH_MATCH)) {
        throw new Error('Infohash must be 40 char hex string')
      }

      if (method === 'HEAD') {
        if (path.endsWith('/')) {
          // TODO: index.html resolution
          const files = await getDirectoryFiles(infoHash, path)
          if (!files.length) {
            return {
              statusCode: 404,
              headers,
              data: []
            }
          }
          const wantsHTML = reqHeaders.accept && reqHeaders.accept.includes('text/html')
          const contentType = wantsHTML ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
          headers['Content-Type'] = contentType
          return {
            statusCode: 200,
            headers,
            data: []
          }
        } else {
          const file = await getFile(infoHash, path)
          if (!file) {
            return {
              statusCode: 404,
              headers,
              data: []
            }
          }
          headers['Content-Type'] = getMimeType(path)
          headers['Content-Length'] = `${file.length}`
          headers['Accept-Ranges'] = 'bytes'
          headers['X-Downloaded'] = `${file.downloaded}`
          return {
            statusCode: 200,
            headers,
            data: []
          }
        }
      } else if (method === 'GET') {
        if (path.endsWith('/') || !path) {
          // TODO: index.html resolution
          const files = await getDirectoryFiles(infoHash, path)
          if (!files.length) {
            return { statusCode: 404, headers, data: [] }
          }
          const wantsHTML = reqHeaders.accept && reqHeaders.accept.includes('text/html')
          const contentType = wantsHTML ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'
          headers['Content-Type'] = contentType
          // TODO: Account for folders

          const filePaths = files
            .map(({ path: filePath }) => filePath.slice(path.length))
            .reduce((final, file) => {
              const segments = file.split('/')
              // TODO: Concat is probably slow as hell
              // If the file is directly within this path, add it to the list
              if (segments.length === 1) return final.concat(file)

              // We've got a file that's in a subfolder of some length
              // We only want to list a folder that's directly within the path
              const subpath = segments[0] + '/'

              // If we've already seen a path in this subfolder, ignore this file
              if (final.includes(subpath)) return final
              return final.concat(subpath)
            }, [])
          if (wantsHTML) {
            return {
              statusCode: 200,
              headers,
              data: [
                Buffer.from(`
<!DOCTYPE html>
<title>${url}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<h1>Index of ${pathname}</h1>
<ul>
  <li><a href="../">../</a></li>${filePaths.map((file) => `
  <li><a href="./${file}">${file}</a></li>`).join('')}
</ul>
`, 'utf8')
              ]
            }
          } else {
            return {
              statusCode: 200,
              headers,
              data: [
                Buffer.from(JSON.stringify(filePaths), 'utf8')
              ]
            }
          }
        } else {
          const file = await getFile(infoHash, path)

          if (!file) {
            return {
              statusCode: 404,
              headers,
              data: ['Not Found']
            }
          }

          headers['Content-Type'] = getMimeType(path)
          headers['Accept-Ranges'] = 'bytes'
          headers['Content-Length'] = `${file.length}`
          // TODO: Should this respond to range requests?
          headers['X-Downloaded'] = `${file.downloaded}`
          const isRanged = reqHeaders.Range || reqHeaders.range
          const readOpts = {}
          const statusCode = isRanged ? 206 : 200

          if (isRanged) {
            const ranges = parseRange(file.length, isRanged)
            if (ranges && ranges.length && ranges.type === 'bytes') {
              const [{ start, end }] = ranges
              const length = (end - start + 1)
              headers['Content-Length'] = `${length}`
              headers['Content-Range'] = `bytes ${start}-${end}/${file.length}`
              readOpts.start = start
              readOpts.end = end
            }
          }

          return {
            statusCode,
            headers,
            // WebTorrent streams use readable-stream instead of node
            // They aren't async-iterable yet, so we have to wrap
            data: nodeStreamToIterator(file.createReadStream(readOpts))
          }
        }
      }

      return {
        statusCode: 400,
        headers,
        data: ['Something went wrong']
      }
    } catch (e) {
      return {
        statusCode: 500,
        data: [e.stack]
      }
    }
  })

  fetch.destroy = () => {
    return new Promise((resolve, reject) => {
      client.destroy((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  return fetch
}

function getMimeType (path) {
  let mimeType = mime.getType(path) || 'text/plain'
  if (mimeType.startsWith('text/')) mimeType = `${mimeType}; charset=utf-8`
  return mimeType
}
