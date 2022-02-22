const WebTorrent = require('webtorrent')
const fs = require('fs-extra')
const path = require('path')
const sha1 = require('simple-sha1')
const ed = require('ed25519-supercop')
const derive = require('derive-key')
const bencode = require('bencode')
const busboy = require('busboy')
const { Readable } = require('stream')
const tmp = require('tmp-promise')
const crypto = require('crypto')

// const {EventIterator} = require('event-iterator')
// const EventEmitter = require('events').EventEmitter

const DERIVE_NAMESPACE = 'bittorrent://'
const ERR_NOT_RESOLVE_ADDRESS = 'Could not resolve address'
// 30 mins delay between reloading torrents
const DEFAULT_RELOAD_INTERVAL = 1000 * 60 * 30

// saves us from saving secret keys(saving secret keys even encrypted secret keys is something i want to avoid)
// with this function which was taken from the bittorrent-dht package
// we save only the signatures when we first publish a BEP46 torrent
function encodeSigData (msg) {
  const ref = { seq: msg.seq, v: msg.v }
  if (msg.salt) ref.salt = msg.salt
  return bencode.encode(ref).slice(1, -1)
}

// setting up constants
const HASH_REGEX = /^[a-fA-F0-9]{40}$/
const ADDRESS_REGEX = /^[a-fA-F0-9]{64}$/

const defOpts = {
  folder: __dirname,
  timeout: 60000,
  reloadInterval: DEFAULT_RELOAD_INTERVAL
}

class TorrentManager {
  constructor (opts = {}) {
    const finalOpts = { ...defOpts, ...opts }
    this.timeout = finalOpts.timeout
    this.reloadInterval = finalOpts.reloadInterval

    this.folder = path.resolve(finalOpts.folder)
    this.dataFolder = path.join(this.folder, 'data')
    this.metadataFolder = path.join(this.folder, 'metadata')
    this.seedKeyFile = path.join(this.folder, 'seed.key')

    fs.ensureDirSync(this.folder)
    fs.ensureDirSync(this.dataFolder)
    fs.ensureDirSync(this.metadataFolder)

    if (fs.existsSync(this.seedKeyFile)) {
      this.seedKey = fs.readFileSync(this.seedKeyFile)
    } else {
      this.seedKey = crypto.randomBytes(32)
      fs.writeFileSync(this.seedKeyFile, this.seedKey)
    }

    this.inProgressLoad = new Map()
    this.byInfohash = new Map()
    this.byPublicKey = new Map()

    this.webtorrent = new WebTorrent({ dht: { verify: ed.verify } })
    this._readyToGo = true

    this.reloadInterval = setInterval(() => this.reloadAll(), this.reloadInterval)
  }

  _trackTorrent (torrent) {
    const { infoHash, publicKey, name, files, path: torrentPath } = torrent
    const parentPath = path.join(torrentPath, name)

    files.forEach((file) => {
      file.relativePath = file.path.slice(parentPath.length).replace(/\\/, '/')
    })

    const infoHashURL = infoHash.toString('hex')
    if (this.byInfohash.has(infoHashURL)) throw new Error('Already tracking ' + infoHashURL)
    this.byInfohash.set(infoHashURL, torrent)
    torrent.on('close', () => {
      this.byInfohash.delete(infoHashURL)
    })

    if (!publicKey) return
    const publicKeyURL = publicKey.toString('hex')
    if (this.byInfohash.has(publicKeyURL)) throw new Error('Already tracking ' + publicKeyURL)
    this.byPublicKey.set(publicKeyURL, torrent)
    torrent.on('close', () => {
      this.byPublicKey.delete(publicKeyURL)
    })
  }

  async resolveTorrent (hostname) {
    if (this.inProgressLoad.has(hostname)) {
      return this.inProgressLoad.get(hostname)
    }
    const loader = this._resolveTorrent(hostname)
    this.inProgressLoad.set(hostname, loader)

    try {
      const torrent = await loader

      return torrent
    } finally {
      this.inProgressLoad.delete(hostname)
    }
  }

  async _resolveTorrent (hostname) {
    const isInfohash = hostname.length === 40 && HASH_REGEX.test(hostname)
    const isPublicKey = hostname.length === 64 && ADDRESS_REGEX.test(hostname)
    if (isInfohash) {
      if (this.byInfohash.has(hostname)) return this.byInfohash.get(hostname)
      return this.loadFromInfoHash(hostname)
    } else if (isPublicKey) {
      if (this.byPublicKey.has(hostname)) return this.byPublicKey.get(hostname)
      return this.loadFromPublicKey(hostname)
    }
  }

  async loadFromInfoHash (infoHash) {
    const torrentFile = await this.loadTorrentFile(infoHash)

    const torrentId = torrentFile || {
      infoHash,
      so: '-1'
    }

    const folderPath = path.join(this.dataFolder, infoHash)
    const torrent = await this.loadTorrent(torrentId, folderPath)

    this._trackTorrent(torrent)

    return torrent
  }

  async loadFromPublicKey (publicKey) {
    const folderPath = path.join(this.dataFolder, publicKey)
    const existingRecord = await this.loadRecord(publicKey)
    // Load latest from DHT, and load the torrent
    try {
      let { infoHash, record, sequence } = await this.resolvePublicKey(publicKey)

      let torrentFile = null
      if (existingRecord && existingRecord?.seq >= sequence) {
        infoHash = existingRecord.v.ih.toString('hex')
        torrentFile = await this.loadTorrentFile(publicKey)
        record = existingRecord
        sequence = existingRecord.seq
      } else {
        await this.saveRecord(publicKey, record)
      }

      const torrentId = torrentFile || {
        infoHash,
        so: '-1'
      }

      const torrent = await this.loadTorrent(torrentId, folderPath)

      torrent.publicKey = publicKey
      torrent.record = record
      torrent.sequence = sequence
      this._trackTorrent(torrent)
      await this.saveTorrentFile(torrent)
      return torrent
    } catch (e) {
      // TODO: Other messages that mean we could not resolve the address?
      if (!e.message.includes(ERR_NOT_RESOLVE_ADDRESS)) throw e

      // If it fails, try loading record from cache
      // Use saved torrent file (underpublickey) to load the torrent
      // TODO: Check error type?
      if (!existingRecord) throw new Error('Could not resolve torrent')

      const torrentFile = await this.loadTorrentFile(publicKey)

      const torrent = await this.loadTorrent(torrentFile, folderPath)
      torrent.record = existingRecord
      torrent.publicKey = publicKey

      this._trackTorrent(torrent)

      return torrent
    }
  }

  async loadTorrent (torrentId, folderPath) {
    await fs.ensureDir(folderPath)

    const options = {
      path: folderPath,
      addUID: false
    }

    const torrent = await Promise.race([
      delayTimeout(this.timeout, new Error('Timeout: torrent took too long to load')),
      new Promise((resolve, reject) => {
        this.webtorrent.add(torrentId, options, torrent => {
          resolve(torrent)
        })
      })
    ])

    return torrent
  }

  async deleteTorrent (hostname) {
    const torrent = await this.resolveTorrent(hostname)
    return new Promise((resolve, reject) => {
      torrent.destroy({ destroyStore: true }, error => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }

  async reloadAll () {
    const all = [...this.byPublicKey.values()]
    await Promise.all(all.map((torrent) => this.reloadTorrent(torrent)))
  }

  async reloadTorrent (torrent) {
    const { publicKey } = torrent
    const loader = this._reloadTorrent(torrent)
    // If the frontend sends a request while we're reloading, make it wait
    this.inProgressLoad.set(publicKey, loader)

    try {
      await loader
    } finally {
      this.inProgressLoad.delete(publicKey)
    }
  }

  async _reloadTorrent (torrent) {
    // Do a DHT get to see if there's a new version (compare sequence)
    const { publicKey } = torrent
    try {
      const { sequence } = await this.resolvePublicKey(publicKey)

      if (sequence > torrent.sequence) {
        // If there's a new version destroy the torrent and load it again
        await new Promise((resolve, reject) => {
          torrent.destroy((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        return this.loadFromPublicKey(publicKey)
      } else {
        // If there isn't do a DHT put with the existing record
        await this.dhtPut(torrent.record)
        return torrent
      }
    } catch {
      // ToDO: Handle errors?
      return torrent
    }
  }

  async publishPublicKey (publicKey, secretKey, headers, data, pathname = '/', name = 'bt-fetch torrent') {
    if (this.byPublicKey.has(publicKey)) {
      await new Promise((resolve, reject) => {
        this.byPublicKey.get(publicKey).destroy((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } else {
      try {
        // Try loading existing state so we can fetch the name out
        const torrent = await this.resolveTorrent(publicKey)

        name = torrent.name

        await new Promise((resolve, reject) => {
          torrent.destroy((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      } catch (e) {
        // Whatever?
        if (!e.message.includes(ERR_NOT_RESOLVE_ADDRESS)) {
          console.error(e.stack)
        }
      }
    }
    const folderPath = path.join(this.dataFolder, publicKey, name)
    const savePath = path.join(folderPath, pathname)
    await fs.ensureDir(savePath)

    const {
      comment,
      createdBy = 'bt-fetch',
      creationDate
    } = await this.handleFormData(savePath, headers, data)

    // TODO: Support "info" field?
    const finalOpts = {
      name,
      comment,
      createdBy,
      creationDate,
      addUID: false
    }

    const tmpTorrent = await new Promise((resolve, reject) => {
      this.webtorrent.seed(folderPath, finalOpts, torrent => {
        resolve(torrent)
      })
    })

    tmpTorrent.publicKey = publicKey

    const { infoHash } = tmpTorrent

    await this.saveTorrentFile(tmpTorrent)

    await new Promise((resolve, reject) => {
      tmpTorrent.destroy((err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Try to resolve existing sequence?
    let sequence = 0
    try {
      const record = await this.dhtGet(publicKey)
      if (record?.seq) {
        sequence = record?.seq
      }
    } catch (e) {
      // Whatever?
      if (!e.message.includes(ERR_NOT_RESOLVE_ADDRESS)) {
        console.error(e)
      }
    }

    // Generate record and publish
    await this.dhtPublish(publicKey, secretKey, infoHash, sequence)

    return this.loadFromPublicKey(publicKey)
  }

  async publishHash (headers, data, pathname = '/', title = 'bt-fetch torrent') {
    const { path: tmpPath, cleanup } = await tmp.dir({ unsafeCleanup: true })
    try {
      await fs.ensureDir(tmpPath)
      const savePath = path.join(tmpPath, pathname)

      const {
        name = title,
        comment,
        createdBy = 'bt-fetch',
        creationDate
      } = await this.handleFormData(savePath, headers, data)

      // TODO: Support "info" field?
      const finalOpts = {
        name,
        comment,
        createdBy,
        creationDate,
        addUID: false
      }

      const tmpTorrent = await new Promise((resolve, reject) => {
        this.webtorrent.seed(tmpPath, finalOpts, torrent => {
          resolve(torrent)
        })
      })

      const { infoHash } = tmpTorrent

      await this.saveTorrentFile(tmpTorrent)

      await new Promise((resolve, reject) => {
        tmpTorrent.destroy((err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      const folderPath = path.join(this.dataFolder, infoHash, name)
      await fs.move(tmpPath, folderPath)

      return this.loadFromInfoHash(infoHash)
    } finally {
      cleanup()
    }
  }

  async dhtGet (publicKey) {
    try {
      const record = await new Promise((resolve, reject) => {
        sha1(Buffer.from(publicKey, 'hex'), (targetID) => {
          this.webtorrent.dht.get(targetID, (err, res) => {
            if (err) {
              reject(err)
            } else if (res) {
              resolve(res)
            } else if (!res) {
              reject(new Error(ERR_NOT_RESOLVE_ADDRESS))
            }
          })
        })
      })
      return record
    } catch (e) {
      if (!e.message.includes(ERR_NOT_RESOLVE_ADDRESS)) {
        console.error('Could not load DHT record', e.stack)
      }
      const record = await this.loadRecord(publicKey)
      if (record) return record
      throw e
    }
  }

  async dhtPut (data) {
    return new Promise((resolve, reject) => {
      this.webtorrent.dht.put(data, (err, hash, nodes) => {
        if (err) {
          reject(err)
        } else {
          resolve(hash.toString('hex'))
        }
      })
    })
  }

  async dhtPublish (publicKey, secretKey, infoHash, seq = 0) {
    const publicKeyBuff = Buffer.from(publicKey, 'hex')
    const secretKeyBuff = Buffer.from(secretKey, 'hex')
    const ih = Buffer.from(infoHash, 'hex')

    const v = { ih }
    const toSign = encodeSigData({ seq, v })

    const sig = ed.sign(toSign, publicKeyBuff, secretKeyBuff)
    const record = { k: publicKeyBuff, v, seq, sig }

    await this.saveRecord(publicKey, record)

    return this.dhtPut(record)
  }

  async loadRecord (publicKey) {
    const fileLocation = path.join(this.folder, 'metadata', `${publicKey}.dht_record`)
    const exists = await fs.pathExists(fileLocation)
    if (!exists) return null
    const buffer = await fs.readFile(fileLocation)
    return bencode.decode(buffer)
  }

  async saveRecord (publicKey, record) {
    const fileLocation = path.join(this.folder, 'metadata', `${publicKey}.dht_record`)
    const buffer = bencode.encode(record)
    await fs.writeFile(fileLocation, buffer)
  }

  async saveTorrentFile (torrent) {
    const { publicKey, infoHash, torrentFile } = torrent
    const hostname = publicKey || infoHash
    const fileLocation = path.join(this.folder, 'metadata', `${hostname}.torrent`)
    await fs.writeFile(fileLocation, torrentFile)
  }

  async loadTorrentFile (hostname) {
    const fileLocation = path.join(this.folder, 'metadata', `${hostname}.torrent`)

    const exists = await fs.pathExists(fileLocation)
    if (!exists) return null
    return fs.readFile(fileLocation)
  }

  // resolve public key address to an infohash
  async resolvePublicKey (publicKey) {
    const record = await this.dhtGet(publicKey)

    const { seq, v } = record
    const { ih } = v

    const infoHash = ih.toString('hex')
    const sequence = seq

    if (!HASH_REGEX.test(infoHash)) throw new Error('Resolved public key infoHash invalid')
    if (!Number.isInteger(sequence)) throw new Error('Resolved public key sequence number invalid')

    return {
      infoHash,
      sequence,
      record
    }
  }

  handleFormData (folderPath, headers, data) {
    const bb = busboy({ headers })
    const additionalInfo = {}

    return new Promise((resolve, reject) => {
      function handleRemoval () {
        bb.off('file', handleFiles)
        bb.off('error', handleErrors)
        bb.off('finish', handleFinish)
      }
      function handleFiles (name, file, info) {
        const { filename } = info
        const finalLocation = path.join(folderPath, filename)
        const writeStream = fs.createWriteStream(finalLocation)
        Readable.from(file).pipe(writeStream)
      }
      function handleErrors (error) {
        handleRemoval()
        reject(error)
      }
      function handleFinish () {
        handleRemoval()
        resolve(additionalInfo)
      }
      function handleField (name, val) {
        additionalInfo[name] = val
      }
      bb.on('file', handleFiles)
      bb.on('field', handleField)
      bb.once('error', handleErrors)
      bb.once('close', handleFinish)
      Readable.from(data).pipe(bb)
    })
  }

  // create a keypair
  createKeypair (petname = null) {
    let seed = null
    if (petname) {
      seed = derive(DERIVE_NAMESPACE, this.seedKey, petname)
    } else {
      seed = ed.createSeed()
    }

    const {
      publicKey,
      secretKey
    } = ed.createKeyPair(seed)

    return {
      publicKey: publicKey.toString('hex'),
      secretKey: secretKey.toString('hex')
    }
  }

  async destroy () {
    clearInterval(this.reloadInterval)
    return new Promise((resolve, reject) => {
      this.webtorrent.destroy(error => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }
}

function delayTimeout (timeout, data, shouldResolve = false) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (shouldResolve) {
        resolve(data)
      } else {
        reject(data)
      }
    }, timeout)
  })
}

module.exports = TorrentManager
