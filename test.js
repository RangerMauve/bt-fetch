import test from 'tape'
import tmp from 'tmp'
import FormData from 'form-data'
import makeBTFetch from './index.js'

tmp.setGracefulCleanup(true)
const folder = tmp.dirSync({ prefix: 'btfetch_example' }).name

const TEST_DATA = 'Hello World!'

test('Create a torrent using FormData to bittorrent://localhost/, check files', async (t) => {
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

    const body = form.getBuffer()
    const headers = form.getHeaders()

    const response = await fetch('bittorrent://localhost/', {
      method: 'POST',
      headers,
      body
    })

    await checkOk(response, t, 'Able to create torrent')

    const createdURL = await response.text()

    t.ok(createdURL.startsWith('bittorrent://'), 'got new bittorrent URL back')
    t.equal(createdURL.length, 'bittorrent://'.length + 40 + 1, 'Bittorrent URL is expected length')

    const listResponse = await fetch(createdURL)

    await checkOk(listResponse, t, 'able to list directory')

    const files = await listResponse.json()
    const expectedFiles = ['example.txt', 'example2.txt'].sort()
    t.deepEqual(files.sort(), expectedFiles.sort(), 'Got listing of uploaded files')

    for (const fileName of files) {
      const fileURL = new URL(fileName, createdURL).href
      const getResponse = await fetch(fileURL)

      await checkOk(getResponse, t, `Able to GET ${fileName}`)
      const fileData = await getResponse.text()
      t.equal(fileData, TEST_DATA, 'Got expected file data ' + fileName)
    }
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
    const expectedFiles = ['example.txt', 'example2.txt'].sort()
    t.deepEqual(files.sort(), expectedFiles.sort(), 'Got listing of uploaded files')

    for (const fileName of files) {
      const fileURL = new URL(fileName, createdURL).href
      const getResponse = await fetch(fileURL)
      const fileData = await getResponse.text()
      t.equal(fileData, TEST_DATA, 'Got expected file data ' + fileName)
    }
  } finally {
    await fetch.destroy()
  }
})

test('Upload to subfolder with petname', async (t) => {
  const fetch = makeBTFetch({
    folder
  })

  try {
    const form1 = new FormData()

    form1.append('file', TEST_DATA, {
      filename: 'example.txt'
    })

    const body1 = form1.getBuffer()
    const headers1 = form1.getHeaders()

    const response1 = await fetch('bittorrent://example2/', {
      method: 'POST',
      headers: headers1,
      body: body1
    })

    // Resolve public key from response headers

    t.ok(response1.ok, 'Successful response')
    const createdURL1 = await response1.text()
    t.equal(createdURL1.length, 'bittorrent://'.length + 64 + 1, 'Bittorrent URL is expected length')
    t.ok(createdURL1.startsWith('bittorrent://'), 'got new bittorrent URL back')

    const form2 = new FormData()

    form2.append('file', TEST_DATA, {
      filename: 'index.md'
    })

    const body2 = form2.getBuffer()
    const headers2 = form2.getHeaders()

    const response2 = await fetch('bittorrent://example2/subfolder/', {
      method: 'POST',
      headers: headers2,
      body: body2
    })

    // Resolve public key from response headers
    t.ok(response2.ok, 'Successful response')
    const createdURL2 = await response2.text()
    t.equal(createdURL2.length, 'bittorrent://'.length + 64 + 1, 'Bittorrent URL is expected length')
    t.ok(createdURL2.startsWith('bittorrent://'), 'got new bittorrent URL back')
    t.equal(createdURL1, createdURL2, 'URL consistent after uploads')

    const listResponse = await fetch(createdURL1)
    t.ok(listResponse.ok, 'able to list directory')
    const files = await listResponse.json()
    const expectedFiles = ['example.txt', 'subfolder/'].sort()
    t.deepEqual(files.sort(), expectedFiles.sort(), 'Got listing of uploaded files')
  } finally {
    await fetch.destroy()
  }
})

test('Re-load petname torrent after closing it', async (t) => {
  let fetch = makeBTFetch({
    folder
  })

  try {
    const form = new FormData()

    form.append('file', TEST_DATA, {
      filename: 'example.txt'
    })

    const body = form.getBuffer()
    const headers = form.getHeaders()

    const response = await fetch('bittorrent://examplereload/', {
      method: 'POST',
      headers,
      body
    })

    // Resolve public key from response headers

    t.ok(response.ok, 'Successful response')
    await response.text()

    await fetch.destroy()

    fetch = makeBTFetch({
      folder
    })

    const response2 = await fetch('bittorrent://examplereload/example.txt')

    t.ok(response2, 'Able to load file back up')
    const text = await response2.text()

    t.equal(text, TEST_DATA, 'Data got loaded back')
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

async function checkOk (response, t, message = 'Response OK') {
  if (!response.ok) {
    t.error(await response.text())
  } else {
    t.pass(message)
  }
}
