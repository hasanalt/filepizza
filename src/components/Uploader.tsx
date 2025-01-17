import React, { useEffect, useState } from 'react'
import { UploadedFile } from '../types'
import { useWebRTC } from './WebRTCProvider'
import useFetch from 'use-http'
import Peer, { DataConnection } from 'peerjs'
import { decodeMessage, Message, MessageType } from '../messages'
import {
  Box,
  Button,
  Input,
  HStack,
  useClipboard,
  VStack,
} from '@chakra-ui/react'
import QRCode from 'react-qr-code'
import produce from 'immer'
import * as t from 'io-ts'
import Loading from './Loading'
import ProgressBar from './ProgressBar'

enum UploaderConnectionStatus {
  Pending = 'PENDING',
  Paused = 'PAUSED',
  Uploading = 'UPLOADING',
  Done = 'DONE',
  InvalidPassword = 'INVALID_PASSWORD',
  Closed = 'CLOSED',
}

type UploaderConnection = {
  status: UploaderConnectionStatus
  dataConnection: DataConnection
  browserName?: string
  browserVersion?: string
  osName?: string
  osVersion?: string
  mobileVendor?: string
  mobileModel?: string
  uploadingFullPath?: string
  uploadingOffset?: number
}

// TODO(@kern): Use better values
const RENEW_INTERVAL = 5000 // 20 minutes
const MAX_CHUNK_SIZE = 10 * 1024 * 1024 // 10 Mi

function useUploaderChannel(
  uploaderPeerID: string,
): {
  loading: boolean
  error: Error | null
  longSlug: string
  shortSlug: string
} {
  const { loading, error, data } = useFetch(
    '/api/create',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploaderPeerID }),
    },
    [uploaderPeerID],
  )

  if (!data) {
    return { loading, error, longSlug: null, shortSlug: null }
  }

  return {
    loading: false,
    error: null,
    longSlug: data.longSlug,
    shortSlug: data.shortSlug,
  }
}

function useUploaderChannelRenewal(shortSlug: string): void {
  const { post } = useFetch('/api/renew')

  useEffect(() => {
    let timeout = null

    const run = (): void => {
      timeout = setTimeout(() => {
        post({ slug: shortSlug })
          .then(() => {
            run()
          })
          .catch((err) => {
            console.error(err)
            run()
          })
      }, RENEW_INTERVAL)
    }

    run()

    return () => {
      clearTimeout(timeout)
    }
  }, [shortSlug])
}

function validateOffset(
  files: UploadedFile[],
  fullPath: string,
  offset: number,
): UploadedFile {
  const validFile = files.find(
    (file) => file.fullPath === fullPath && offset <= file.size,
  )
  if (!validFile) {
    throw new Error('invalid file offset')
  }
  return validFile
}

function useUploaderConnections(
  peer: Peer,
  files: UploadedFile[],
  password: string,
): Array<UploaderConnection> {
  const [connections, setConnections] = useState<Array<UploaderConnection>>([])

  useEffect(() => {
    peer.on('connection', (conn: DataConnection) => {
      let sendChunkTimeout: number | null = null
      const newConn = {
        status: UploaderConnectionStatus.Pending,
        dataConnection: conn,
      }

      setConnections((conns) => [...conns, newConn])
      const updateConnection = (
        fn: (draftConn: UploaderConnection) => void,
      ) => {
        setConnections((conns) =>
          produce(conns, (draft) => {
            const updatedConn = draft.find((c) => c.dataConnection === conn)
            if (!updatedConn) {
              return
            }

            fn(updatedConn)
          }),
        )
      }

      conn.on('data', (data): void => {
        try {
          const message = decodeMessage(data)
          switch (message.type) {
            case MessageType.RequestInfo: {
              if (message.password !== password) {
                const request: t.TypeOf<typeof Message> = {
                  type: MessageType.Error,
                  error: 'Invalid password',
                }

                conn.send(request)

                updateConnection((draft) => {
                  if (draft.status !== UploaderConnectionStatus.Pending) {
                    return
                  }

                  draft.status = UploaderConnectionStatus.InvalidPassword
                  draft.browserName = message.browserName
                  draft.browserVersion = message.browserVersion
                  draft.osName = message.osName
                  draft.osVersion = message.osVersion
                  draft.mobileVendor = message.mobileVendor
                  draft.mobileModel = message.mobileModel
                })

                return
              }

              updateConnection((draft) => {
                if (draft.status !== UploaderConnectionStatus.Pending) {
                  return
                }

                draft.status = UploaderConnectionStatus.Paused
                draft.browserName = message.browserName
                draft.browserVersion = message.browserVersion
                draft.osName = message.osName
                draft.osVersion = message.osVersion
                draft.mobileVendor = message.mobileVendor
                draft.mobileModel = message.mobileModel
              })

              const fileInfo = files.map((f) => {
                return {
                  fullPath: f.fullPath,
                  size: f.size,
                  type: f.type,
                }
              })

              const request: t.TypeOf<typeof Message> = {
                type: MessageType.Info,
                files: fileInfo,
              }
              conn.send(request)
              break
            }

            case MessageType.Start: {
              const fullPath = message.fullPath
              let offset = message.offset
              const file = validateOffset(files, fullPath, offset)
              updateConnection((draft) => {
                if (draft.status !== UploaderConnectionStatus.Paused) {
                  return
                }

                draft.status = UploaderConnectionStatus.Uploading
                draft.uploadingFullPath = fullPath
                draft.uploadingOffset = offset
              })

              const sendNextChunk = () => {
                const end = Math.min(file.size, offset + MAX_CHUNK_SIZE)
                const chunkSize = end - offset
                const final = chunkSize < MAX_CHUNK_SIZE
                const request: t.TypeOf<typeof Message> = {
                  type: MessageType.Chunk,
                  fullPath,
                  offset,
                  bytes: file.slice(offset, end),
                  final,
                }
                conn.send(request)

                updateConnection((draft) => {
                  offset = end
                  draft.uploadingOffset = end

                  if (final) {
                    draft.status = UploaderConnectionStatus.Paused
                  } else {
                    sendChunkTimeout = setTimeout(() => {
                      sendNextChunk()
                    }, 0)
                  }
                })
              }
              sendNextChunk()

              break
            }

            case MessageType.Pause: {
              updateConnection((draft) => {
                if (draft.status !== UploaderConnectionStatus.Uploading) {
                  return
                }

                draft.status = UploaderConnectionStatus.Paused
                if (sendChunkTimeout) {
                  clearTimeout(sendChunkTimeout)
                  sendChunkTimeout = null
                }
              })
              break
            }

            case MessageType.Done: {
              updateConnection((draft) => {
                if (draft.status !== UploaderConnectionStatus.Paused) {
                  return
                }

                draft.status = UploaderConnectionStatus.Done
                conn.close()
              })
              break
            }
          }
        } catch (err) {
          console.error(err)
        }
      })

      conn.on('close', (): void => {
        if (sendChunkTimeout) {
          clearTimeout(sendChunkTimeout)
        }

        updateConnection((draft) => {
          if (
            [
              UploaderConnectionStatus.InvalidPassword,
              UploaderConnectionStatus.Done,
            ].includes(draft.status)
          ) {
            return
          }

          draft.status = UploaderConnectionStatus.Closed
        })
      })
    })
  }, [peer, files, password])

  return connections
}

export default function Uploader({
  files,
  password,
}: {
  files: UploadedFile[]
  password: string
}): JSX.Element {
  const peer = useWebRTC()
  const { longSlug, shortSlug } = useUploaderChannel(peer.id)
  useUploaderChannelRenewal(shortSlug)
  const connections = useUploaderConnections(peer, files, password)

  const hostPrefix =
    window.location.protocol +
    '//' +
    window.location.hostname +
    (['80', '443'].includes(window.location.port)
      ? ''
      : ':' + window.location.port)
  const longURL = `${hostPrefix}/download/${longSlug}`
  const shortURL = `${hostPrefix}/download/${shortSlug}`
  const { hasCopied: hasCopiedLongURL, onCopy: onCopyLongURL } = useClipboard(
    longURL,
  )
  const { hasCopied: hasCopiedShortURL, onCopy: onCopyShortURL } = useClipboard(
    shortURL,
  )

  if (!longSlug || !shortSlug) {
    return <Loading text="Creating channel" />
  }

  return (
    <>
      <HStack w="100%">
        <Box flex="none">
          <QRCode value={shortURL} size={88} />
        </Box>
        <VStack flex="auto">
          <HStack w="100%">
            <Input value={longURL} isReadOnly fontSize="10px" />
            <Button
              onClick={onCopyLongURL}
              variant="ghost"
              colorScheme="blackAlpha"
            >
              {hasCopiedLongURL ? 'Copied' : 'Copy'}
            </Button>
          </HStack>
          <HStack w="100%">
            <Input value={shortURL} isReadOnly fontSize="10px" />
            <Button
              onClick={onCopyShortURL}
              variant="ghost"
              colorScheme="blackAlpha"
            >
              {hasCopiedShortURL ? 'Copied' : 'Copy'}
            </Button>
          </HStack>
        </VStack>
      </HStack>
      {connections.map((conn, i) => (
        <Box key={i} w="100%">
          {/* TODO(@kern): Make this look nicer */}
          {conn.status} {conn.browserName} {conn.browserVersion}
          <ProgressBar value={50} max={100} />
        </Box>
      ))}
    </>
  )
}
