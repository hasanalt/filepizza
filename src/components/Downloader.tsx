import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useWebRTC } from './WebRTCProvider'
import {
  browserName,
  browserVersion,
  osName,
  osVersion,
  mobileVendor,
  mobileModel,
} from 'react-device-detect'
import * as t from 'io-ts'
import { ChunkMessage, decodeMessage, Message, MessageType } from '../messages'
import { createZipStream } from '../zip-stream'
import { DataConnection } from 'peerjs'
import PasswordField from './PasswordField'
import UnlockButton from './UnlockButton'
import { chakra, Box, Text, VStack } from '@chakra-ui/react'
import Loading from './Loading'
import UploadFileList from './UploadFileList'
import DownloadButton from './DownloadButton'
import StopButton from './StopButton'
import ProgressBar from './ProgressBar'

const baseURL = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

// eslint-disable-next-line @typescript-eslint/no-var-requires
if (process.browser) require('web-streams-polyfill/ponyfill')

// eslint-disable-next-line @typescript-eslint/no-var-requires
const streamSaver = process.browser ? require('streamsaver') : null
if (process.browser) {
  streamSaver.mitm = baseURL + '/stream.html'
}

function getZipFilename(): string {
  return `filepizza-download-${Date.now()}.zip`
}

function cleanErrorMessage(errorMessage: string): string {
  if (errorMessage.startsWith('Could not connect to peer')) {
    return 'Could not connect to the uploader. Did they close their browser?'
  } else {
    return errorMessage
  }
}

type DownloadFileStream = {
  name: string
  size: number
  stream: () => ReadableStream
}

export async function streamDownloadSingleFile(
  file: DownloadFileStream,
): Promise<void> {
  const fileStream = streamSaver.createWriteStream(file.name, {
    size: file.size,
  })

  const writer = fileStream.getWriter()
  const reader = file.stream().getReader()

  const pump = async () => {
    const res = await reader.read()
    return res.done ? writer.close() : writer.write(res.value).then(pump)
  }
  await pump()
}

export function streamDownloadMultipleFiles(
  files: Array<DownloadFileStream>,
): Promise<void> {
  const filename = getZipFilename()
  const totalSize = files.reduce((acc, file) => acc + file.size, 0)
  const fileStream = streamSaver.createWriteStream(filename, {
    size: totalSize,
  })

  const readableZipStream = createZipStream({
    start(ctrl) {
      for (const file of files) {
        ctrl.enqueue(file)
      }
      ctrl.close()
    },
    async pull(_ctrl) {
      // Gets executed everytime zip-stream asks for more data
    },
  })

  return readableZipStream.pipeTo(fileStream)
}

export default function Downloader({
  uploaderPeerID,
}: {
  uploaderPeerID: string
}): JSX.Element {
  const peer = useWebRTC()

  const [password, setPassword] = useState('')
  const [dataConnection, setDataConnection] = useState<DataConnection | null>(
    null,
  )
  const [filesInfo, setFilesInfo] = useState<Array<{
    fullPath: string
    size: number
    type: string
  }> | null>(null)
  const processChunk = useRef<
    ((message: t.TypeOf<typeof ChunkMessage>) => void) | null
  >(null)
  const [shouldAttemptConnection, setShouldAttemptConnection] = useState(false)
  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [bytesDownloaded, setBytesDownloaded] = useState(0)
  const [done, setDone] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!shouldAttemptConnection) {
      return
    }

    const conn = peer.connect(uploaderPeerID, {
      reliable: true,
    })

    setDataConnection(conn)

    const handleOpen = () => {
      setOpen(true)

      const request: t.TypeOf<typeof Message> = {
        type: MessageType.RequestInfo,
        browserName: browserName,
        browserVersion: browserVersion,
        osName: osName,
        osVersion: osVersion,
        mobileVendor: mobileVendor,
        mobileModel: mobileModel,
        password,
      }

      conn.send(request)
    }

    const handleData = (data: unknown) => {
      try {
        const message = decodeMessage(data)
        switch (message.type) {
          case MessageType.Info:
            console.log(message.files)
            setFilesInfo(message.files)
            break

          case MessageType.Chunk:
            if (processChunk.current) processChunk.current(message)
            break

          case MessageType.Error:
            console.error(message.error)
            setErrorMessage(message.error)
            conn.close()
            break
        }
      } catch (err) {
        console.error(err)
      }
    }

    const handleClose = () => {
      setDataConnection(null)
      setOpen(false)
      setDownloading(false)
      setShouldAttemptConnection(false)
    }

    const handlePeerError = (err: Error) => {
      console.error(err)
      setErrorMessage(cleanErrorMessage(err.message))
      if (conn.open) {
        conn.close()
      } else {
        handleClose()
      }
    }

    const handleConnectionError = (err: Error) => {
      console.error(err)
      setErrorMessage(cleanErrorMessage(err.message))
      if (conn.open) conn.close()
    }

    conn.on('open', handleOpen)
    conn.on('data', handleData)
    conn.on('error', handleConnectionError)
    conn.on('close', handleClose)
    peer.on('error', handlePeerError)

    return () => {
      if (conn.open) conn.close()
      conn.off('open', handleOpen)
      conn.off('data', handleData)
      conn.off('error', handleConnectionError)
      conn.off('close', handleClose)
      peer.off('error', handlePeerError)
    }
  }, [peer, password, shouldAttemptConnection])

  const handleSubmitPassword = useCallback((ev) => {
    ev.preventDefault()
    setShouldAttemptConnection(true)
  }, [])

  const handleStartDownload = useCallback(() => {
    setDownloading(true)

    const fileStreamByPath: Record<
      string,
      {
        stream: ReadableStream
        enqueue: (chunk: any) => void
        close: () => void
      }
    > = {}
    const fileStreams = filesInfo.map((info) => {
      let enqueue: ((chunk: any) => void) | null = null
      let close: (() => void) | null = null
      const stream = new ReadableStream({
        start(ctrl) {
          enqueue = (chunk: any) => ctrl.enqueue(chunk)
          close = () => ctrl.close()
        },
      })
      fileStreamByPath[info.fullPath] = {
        stream,
        enqueue,
        close,
      }
      return stream
    })

    let nextFileIndex = 0
    const startNextFileOrFinish = (): void => {
      if (nextFileIndex >= filesInfo.length) {
        return
      }

      const request: t.TypeOf<typeof Message> = {
        type: MessageType.Start,
        fullPath: filesInfo[nextFileIndex].fullPath,
        offset: 0,
      }
      dataConnection.send(request)
      nextFileIndex++
    }

    const processChunkFunc = (message: t.TypeOf<typeof ChunkMessage>): void => {
      const fileStream = fileStreamByPath[message.fullPath]
      if (!fileStream) {
        console.error('no stream found for ' + message.fullPath)
        return
      }

      setBytesDownloaded((bd) => bd + (message.bytes as ArrayBuffer).byteLength)
      const uInt8 = new Uint8Array(message.bytes as ArrayBuffer)
      fileStream.enqueue(uInt8)
      if (message.final) {
        fileStream.close()
        startNextFileOrFinish()
      }
    }
    processChunk.current = processChunkFunc

    const downloads = filesInfo.map((info, i) => ({
      name: info.fullPath.replace(/^\//, ''),
      size: info.size,
      stream: () => fileStreams[i],
    }))

    let downloadPromise: Promise<void> | null = null
    if (downloads.length > 1) {
      downloadPromise = streamDownloadMultipleFiles(downloads)
    } else if (downloads.length === 1) {
      downloadPromise = streamDownloadSingleFile(downloads[0])
    } else {
      throw new Error('no files to download')
    }

    downloadPromise
      .then(() => {
        const request: t.TypeOf<typeof Message> = {
          type: MessageType.Done,
        }
        dataConnection.send(request)
        setDone(true)
      })
      .catch((err) => {
        console.error(err)
      })

    startNextFileOrFinish()
  }, [dataConnection, filesInfo])

  const handleStopDownload = useCallback(() => {
    // TODO(@kern): Implement me
  }, [])

  const totalSize = filesInfo
    ? filesInfo.reduce((acc, info) => acc + info.size, 0)
    : 0

  if (done && filesInfo) {
    return (
      <VStack spacing="20px" w="100%">
        <Text textStyle="description">
          You downloaded {filesInfo.length} files.
        </Text>
        <UploadFileList files={filesInfo} />
        <Box w="100%">
          <ProgressBar value={bytesDownloaded} max={totalSize} />
        </Box>
      </VStack>
    )
  }

  if (downloading && filesInfo) {
    return (
      <VStack spacing="20px" w="100%">
        <Text textStyle="description">
          You are about to start downloading {filesInfo.length} files.
        </Text>
        <UploadFileList files={filesInfo} />
        <Box w="100%">
          <ProgressBar value={bytesDownloaded} max={totalSize} />
        </Box>
        <StopButton onClick={handleStopDownload} isDownloading />
      </VStack>
    )
  }

  if (open && filesInfo) {
    return (
      <VStack spacing="20px" w="100%">
        <Text textStyle="description">
          You are about to start downloading {filesInfo.length} files.
        </Text>
        <UploadFileList files={filesInfo} />
        <DownloadButton onClick={handleStartDownload} />
      </VStack>
    )
  }

  if (open) {
    return <Loading text="Listing uploaded files" />
  }

  // TODO(@kern): Connect immediately, then have server respond if password is needed.
  if (shouldAttemptConnection) {
    return <Loading text="Connecting to uploader" />
  }

  return (
    <chakra.form
      action="#"
      method="post"
      onSubmit={handleSubmitPassword}
      w="100%"
    >
      <VStack spacing="20px" w="100%">
        {errorMessage ? (
          <Text textStyle="descriptionError">{errorMessage}</Text>
        ) : (
          <Text textStyle="description">
            This download requires a password.
          </Text>
        )}
        <PasswordField
          value={password}
          onChange={setPassword}
          isRequired
          isInvalid={Boolean(errorMessage)}
        />
        <UnlockButton onClick={handleSubmitPassword} />
      </VStack>
    </chakra.form>
  )
}
