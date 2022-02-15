const test = require('tape')
const tmp = require('tmp')
const FormData = require('form-data')
const makeBTFetch = require('./')

tmp.setGracefulCleanup()
const folder = tmp.dirSync({ prefix: 'btfetch_example' }).name

const TEST_DATA = 'Hello World!'

test('Create a torrent using FormData to bittorrent://$/, check files', async (t) => {
  const fetch = makeBTFetch({
    folder
  })

  try {
    const form = new FormData()

    form.append('name', 'TestTorrent')
    form.append('file2', TEST_DATA, {
      filename: 'example.txt'
    })
    form.append('file', TEST_DATA, {
      filename: 'example2.txt'
    })
    // TODO: Figure out subfolders, might only work for mutable torrents?
    form.append('file', TEST_DATA, {
      filename: 'foldler/example.md'
    })

    const body = form.getBuffer()
    const headers = form.getHeaders()

    const response = await fetch('bittorrent://$/', {
      method: 'POST',
      headers,
      body
    })

    t.ok(response.ok, 'Successful response')
    const createdURL = await response.text()

    t.ok(createdURL.startsWith('bittorrent://'), 'got new bittorrent URL back')
    t.equal(createdURL.length, 'bittorrent://'.length + 40 + 1, 'Bittorrent URL is expected length')

    const listResponse = await fetch(createdURL)
    t.ok(listResponse.ok, 'able to list directory')
    const files = await listResponse.json()
    const expectedFiles = ['example.txt', 'example2.txt', 'example.md'].sort()
    t.deepEqual(files.sort(), expectedFiles.sort(), 'Got listing of uploaded files')
  } finally {
    await fetch.destroy()
  }
})

test('Create a torrent using FormData to petname', async (t) => {
  const fetch = makeBTFetch({
    folder
  })

  try {
    const form = new FormData()

    form.append('name', 'TestTorrent')
    form.append('file2', TEST_DATA, {
      filename: 'example.txt'
    })
    form.append('file', TEST_DATA, {
      filename: 'example2.txt'
    })
    // TODO: Figure out subfolders, might only work for mutable torrents?
    form.append('file', TEST_DATA, {
      filename: 'foldler/example.md'
    })

    const body = form.getBuffer()
    const headers = form.getHeaders()

    const response = await fetch('bittorrent://example/', {
      method: 'POST',
      headers,
      body
    })

    // Resolve public key from response headers

    t.ok(response.ok, 'Successful response')
    const createdURL = await response.text()
    t.equal(createdURL.length, 'bittorrent://'.length + 64 + 1, 'Bittorrent URL is expected length')
    t.ok(createdURL.startsWith('bittorrent://'), 'got new bittorrent URL back')

    const listResponse = await fetch(createdURL)
    t.ok(listResponse.ok, 'able to list directory')
    const files = await listResponse.json()
    const expectedFiles = ['example.txt', 'example2.txt', 'example.md'].sort()
    t.deepEqual(files.sort(), expectedFiles.sort(), 'Got listing of uploaded files')
  } finally {
    await fetch.destroy()
  }
})

test('Test loading a well-seeded file', async (t) => {
  const fetch = makeBTFetch({
    folder
  })

  // InfoHash for the Sintel torrent
  // Taken from https://webtorrent.io/docs
  const url = 'bittorrent://08ada5a7a6183aae1e09d831df6748d566095a10/'
  try {
    const res = await fetch(url)

    t.ok(res.ok, 'Response successful')
    t.equal(res.status, 200, '200 OK')

    const files = await res.json()

    console.log(files)

    const resHTML = await fetch(url, {
      headers: {
        Accept: 'text/html'
      }
    })

    console.log('As HTML', await resHTML.text())

    const srtURL = url + 'Sintel.en.srt'

    console.log('Fetching subtitle track metadata')
    console.log(srtURL)

    const resHead = await fetch(srtURL, { method: 'head' })

    const { headers, status } = resHead

    console.log({
      headers: [...headers],
      status
    })

    console.log('Getting contents of srt file')

    const resSRT = await fetch(srtURL)

    for await (const chunk of resSRT.body) {
      console.log('Chunk:', chunk)
    }
  } finally {
    await fetch.destroy()
  }
})
