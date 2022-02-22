const makeFetch = require('make-fetch')
const TorrentManager = require('./torrent-manager.js')
const streamToIterator = require('stream-async-iterator')
const mime = require('mime/lite')
const parseRange = require('range-parser')

const HASH_REGEX = /^[a-fA-F0-9]{40}$/
const ADDRESS_REGEX = /^[a-fA-F0-9]{64}$/
const PETNAME_REGEX = /^(?:-|[a-zA-Z0-9]|_)+$/
// const DOMAIN_REGEX = /^(?:-|[a-zA-Z0-9]|\.)+$/
const META_HOSTNAME = '$'
const DEFAULT_OPTS = {
  folder: __dirname,
  storage: 'storage',
  author: 'author'
}

const SUPPORTED_METHODS = ['GET', 'POST', 'DELETE', 'HEAD']

module.exports = function makeBTFetch (opts = {}) {
  const finalOpts = { ...DEFAULT_OPTS, ...opts }

  const torrents = new TorrentManager(finalOpts)

  const fetch = makeFetch(async ({ url, method, headers: reqHeaders, body }) => {
    const { hostname, pathname, protocol, searchParams } = new URL(url)
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8'
    }
    try {
      const isInfohash = hostname.length === 40 && HASH_REGEX.test(hostname)
      const isPublicKey = hostname.length === 64 && ADDRESS_REGEX.test(hostname)
      const isSpecialHostname = hostname === META_HOSTNAME
      const isHEAD = method === 'HEAD'
      const isWebframe = reqHeaders.accept && reqHeaders.accept.includes('text/html')
      const isFormData = reqHeaders['content-type'] && reqHeaders['content-type'].includes('multipart/form-data')
      const isPetname = PETNAME_REGEX.test(hostname)
      // Domains must have at least one `.` to differentiate them from petnames
      // This will come in handy once we get DNSLink working
      // const isDomain = !isPetname && DOMAIN_REGEX.test(hostname)

      function formatResponse (statusCode, responseData = '') {
        const data = [responseData]
        return {
          statusCode,
          headers,
          data
        }
      }

      function formatJSON (statusCode, json = {}) {
        headers['Content-Type'] = 'application/json; charset=utf-8'
        return formatResponse(statusCode, JSON.stringify(json, null, '\t'))
      }

      function formatHTML (statusCode, html = '') {
        headers['Content-Type'] = 'text/html; charset=utf-8'
        return formatResponse(statusCode, html)
      }

      if (protocol !== 'bittorrent:') {
        return formatResponse(409, 'wrong protocol')
      } else if (!method || !SUPPORTED_METHODS.includes(method)) {
        return formatResponse(409, 'something wrong with method')
      } else if (!hostname && !isSpecialHostname && !isInfohash && !isPublicKey) {
        return formatResponse(409, 'Hostname must be an infohash, a public key, or the $ folder')
      }

      // TODO handle isDomain

      const rangeHeader = reqHeaders.Range || reqHeaders.range

      if ((method === 'GET') || isHEAD) {
        if (isSpecialHostname) {
          if (isHEAD) return formatResponse(200)
          // TODO: List active torrents?
          return formatResponse(200, isWebframe ? '' : 'Thank you for using BT-Fetch')
        } else {
          const torrent = await torrents.resolveTorrent(hostname)
          const canonical = `bittorrent://${torrent.infoHash}${pathname || '/'}`
          headers.Link = `<${canonical}>; rel="canonical"`

          const foundFile = findFile(torrent, pathname)
          if (foundFile) {
            headers['Content-Type'] = getMimeType(pathname)
            headers['Content-Length'] = foundFile.length
            if (rangeHeader) {
              const ranges = parseRange(foundFile.length, rangeHeader)
              if (ranges && ranges.length && ranges.type === 'bytes') {
                const [{ start, end }] = ranges
                const length = (end - start + 1)

                headers['Content-Length'] = `${length}`
                headers['Content-Range'] = `bytes ${start}-${end}/${foundFile.length}`

                const data = isHEAD ? [] : streamToIterator(foundFile.createReadStream({ start, end }))
                return { statusCode: 206, headers, data }
              } else {
                const data = isHEAD ? [] : streamToIterator(foundFile.createReadStream())
                return { statusCode: 200, headers, data }
              }
            } else {
              const data = isHEAD ? [] : streamToIterator(foundFile.createReadStream())
              return { statusCode: 200, headers, data }
            }
          } else {
            // Try finding files in directory
            // TODO: Resolve index files
            const directoryPath = pathname.endsWith('/') ? pathname : (pathname + '/')
            const files = findDirectoryFiles(torrent, directoryPath)
            // If no files are found that means the directory doesn't exist
            if (!files.length) {
              const notFoundError = new Error('Not found')
              notFoundError.statusCode = 404
              throw notFoundError
            }

            return formatJSON(200, files)
          }
        }
      } else if (method === 'POST') {
        if (isSpecialHostname) {
          if (!body) throw new Error('Must specify body for uploads')
          if (!isFormData) {
            throw new Error('Must specify multipart/form-data in body')
          }
          const torrent = await torrents.publishHash(reqHeaders, body, pathname)
          return formatResponse(200, `bittorrent://${torrent.infoHash}/`)
        } else {
          if (!isFormData) {
            throw new Error('Must specify multipart/form-data in body')
          }
          if (isInfohash) {
            throw new Error('Cannot update immutable torrents')
          }
          let { publicKey, secretKey } = torrents.createKeypair(hostname)
          if (isPublicKey) {
            if (!reqHeaders.authorization) {
              throw new Error('Must specify secret key in authorization header')
            }
            publicKey = hostname
            secretKey = reqHeaders.authorization
          } else if (!isPetname) {
            throw new Error('Public keys not supported yet')
          }
          const torrent = await torrents.publishPublicKey(publicKey, secretKey, reqHeaders, body, pathname, hostname)
          return formatResponse(200, `bittorrent://${torrent.publicKey}/`)
        }
      } else if (method === 'DELETE') {
        if (isSpecialHostname) {
          throw new Error('Must specify address')
        } else {
          await torrents.deleteTorrent(hostname)
          return formatResponse(200, 'OK')
        }
      } else {
        return formatResponse(409, 'Method not allowed')
      }
    } catch (e) {
      console.error(e.stack)
      const statusCode = e.statusCode ? e.statusCode : 500
      return { statusCode, headers, data: [e.stack] }
    }
  })

  fetch.destroy = () => {
    return torrents.destroy()
  }

  return fetch
}

function findFile (torrent, filePath) {
  return torrent.files.find(({ relativePath }) => relativePath === filePath)
}

function findDirectoryFiles (torrent, directoryPath) {
  return torrent.files
    .filter(({ relativePath }) => relativePath.startsWith(directoryPath))
    .map(({ relativePath }) => relativePath.slice(directoryPath.length))
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
}

function getMimeType (path) {
  let mimeType = mime.getType(path) || 'text/plain'
  if (mimeType.startsWith('text/')) mimeType = `${mimeType}; charset=utf-8`
  return mimeType
}
