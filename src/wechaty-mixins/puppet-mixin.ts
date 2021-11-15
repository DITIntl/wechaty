import * as PUPPET      from 'wechaty-puppet'
import { log }          from 'wechaty-puppet'
import {
  GError,
  timeoutPromise,
  TimeoutPromiseGError,
}                       from 'gerror'

import { StateSwitch }  from 'state-switch'
import type {
  StateSwitchInterface,
}                       from 'state-switch'

import { timestampToDate }        from '../pure-functions/timestamp-to-date.js'
import type { ContactInterface }  from '../user-modules/contact.js'
import {
  PuppetManager,
}                                 from '../puppet-management/mod.js'

import type {
  WechatifyUserModuleMixin,
}                                 from './wechatify-user-module-mixin.js'

import { config }           from '../config.js'
import type { GErrorMixin } from './gerror-mixin.js'

const PUPPET_MEMORY_NAME = 'puppet'

const puppetMixin = <MixinBase extends WechatifyUserModuleMixin & GErrorMixin> (mixinBase: MixinBase) => {
  log.verbose('WechatyPuppetMixin', 'puppetMixin(%s)', mixinBase.name)

  abstract class PuppetMixin extends mixinBase {

    __puppet?: PUPPET.impl.PuppetInterface

    get puppet (): PUPPET.impl.PuppetInterface {
      if (!this.__puppet) {
        throw new Error('NOPUPPET')
      }
      return this.__puppet
    }

    readonly __readyState : StateSwitchInterface

    constructor (...args: any[]) {
      log.verbose('WechatyPuppetMixin', 'construct()')
      super(...args)

      this.__readyState = new StateSwitch('WechatyReady', { log })
    }

    override async start (): Promise<void> {
      log.verbose('WechatyPuppetMixin', 'start()')

      log.verbose('WechatyPuppetMixin', 'start() super.start() ...')
      await super.start()
      log.verbose('WechatyPuppetMixin', 'start() super.start() ... done')

      try {
        /**
         * reset the `wechaty.ready()` state
         *  if it was previous set to `active`
         */
        if (this.__readyState.active()) {
          this.__readyState.inactive(true)
        }

        log.verbose('WechatyPuppetMixin', 'start() initializing puppet instance ...')
        await this.__initPuppetInstance()
        log.verbose('WechatyPuppetMixin', 'start() initializing puppet instance ... done')

        try {
          log.verbose('WechatyPuppetMixin', 'start() starting puppet ...')
          await timeoutPromise(
            this.puppet.start(),
            15 * 1000,  // 15 seconds timeout
            () => GError.from('TIMEOUT'),
          )
          log.verbose('WechatyPuppetMixin', 'start() starting puppet ... done')
        } catch (e) {
          if (e instanceof TimeoutPromiseGError) {
            /**
             * Huan(202111):
             *
             *  We should throw the Timeout error when the puppet.start() can not be finished in time.
             *  However, we need to compatible with some buggy puppet implementations which will not resolve the promise.
             *
             * TODO: throw the Timeout error when the puppet.start() can not be finished in time.
             *
             * e.g. after resolve @issue https://github.com/padlocal/wechaty-puppet-padlocal/issues/116
             */
            log.warn('WechatyPuppetMixin', 'start() starting puppet ... timeout')
            log.warn('WechatyPuppetMixin', 'start() puppet info: %s', this.puppet)
          } else {
            throw e
          }
        }

      } catch (e) {
        this.emitError(e)
      }
    }

    override async stop (): Promise<void> {
      log.verbose('WechatyPuppetMixin', 'stop()')

      try {
        log.verbose('WechatyPuppetMixin', 'stop() stopping puppet ...')
        await timeoutPromise(
          this.puppet.stop(),
          15 * 1000,  // 15 seconds timeout
        )
        log.verbose('WechatyPuppetMixin', 'stop() stopping puppet ... done')
      } catch (e) {
        if (e instanceof TimeoutPromiseGError) {
          log.warn('WechatyPuppetMixin', 'stop() stopping puppet ... timeout')
          log.warn('WechatyPuppetMixin', 'stop() puppet info: %s', this.puppet)
        }
        this.emitError(e)
      }

      log.verbose('WechatyPuppetMixin', 'stop() super.stop() ...')
      await super.stop()
      log.verbose('WechatyPuppetMixin', 'stop() super.stop() ... done')
    }

    async ready (): Promise<void> {
      log.verbose('WechatyPuppetMixin', 'ready()')
      await this.__readyState.stable('active')
      log.silly('WechatyPuppetMixin', 'ready() this.readyState.stable(on) resolved')
    }

    async __initPuppetInstance (): Promise<void> {
      log.verbose('WechatyPuppetMixin', '_initPuppetInstance() %s', this._options.puppet || '')

      if (this.__puppet) {
        log.verbose('WechatyPuppetMixin', '_initPuppetInstance() initialized already: skip')
        return
      }

      log.verbose('WechatyPuppetMixin', '_initPuppetInstance() instanciating puppet instance ...')
      const puppet       = this._options.puppet || config.systemPuppetName()
      const puppetMemory = this.memory.multiplex(PUPPET_MEMORY_NAME)

      const puppetInstance = await PuppetManager.resolve({
        puppet,
        puppetOptions : this._options.puppetOptions,
        // wechaty       : this,
      })
      log.verbose('WechatyPuppetMixin', '_initPuppetInstance() instanciating puppet instance ... done')

      /**
       * Plug the Memory Card to Puppet
       */
      log.verbose('WechatyPuppetMixin', '_initPuppetInstance() setting memory ...')
      puppetInstance.setMemory(puppetMemory)
      log.verbose('WechatyPuppetMixin', '_initPuppetInstance() setting memory ... done')

      this.__puppet = puppetInstance

      log.verbose('WechatyPuppetMixin', '_initPuppetInstance() setting up events ...')
      this.__setupPuppetEvents(puppetInstance)
      log.verbose('WechatyPuppetMixin', '_initPuppetInstance() setting up events ... done')
      // this._wechatifyUserModules()

      /**
        * Private Event
        *   - Huan(202005): emit puppet when set
        *   - Huan(202110): @see https://github.com/wechaty/redux/blob/16af0ae01f72e37f0ee286b49fa5ccf69850323d/src/wechaty-redux.ts#L82-L98
        */
      log.verbose('WechatyPuppetMixin', '_initPuppetInstance() emitting "puppet" event ...')
      ;(this.emit as any)('puppet', puppetInstance)
      log.verbose('WechatyPuppetMixin', '_initPuppetInstance() emitting "puppet" event ... done')
    }

    __setupPuppetEvents (puppet: PUPPET.impl.PuppetInterface): void {
      log.verbose('WechatyPuppetMixin', '_setupPuppetEvents(%s)', puppet)

      const eventNameList: PUPPET.type.PuppetEventName[] = Object.keys(PUPPET.type.PUPPET_EVENT_DICT) as PUPPET.type.PuppetEventName[]
      for (const eventName of eventNameList) {
        log.verbose('PuppetMixin',
          '_setupPuppetEvents() puppet.on(%s) (listenerCount:%s) registering...',
          eventName,
          puppet.listenerCount(eventName),
        )

        switch (eventName) {
          case 'dong':
            puppet.on('dong', payload => {
              this.emit('dong', payload.data)
            })
            break

          case 'error':
            puppet.on('error', payload => {
              this.emit('error', GError.from(payload))
            })
            break

          case 'heartbeat':
            puppet.on('heartbeat', payload => {
              /**
               * Use `watchdog` event from Puppet to `heartbeat` Wechaty.
               */
              // TODO: use a throttle queue to prevent beat too fast.
              this.emit('heartbeat', payload.data)
            })
            break

          case 'friendship':
            puppet.on('friendship', async payload => {
              const friendship = this.Friendship.load(payload.friendshipId)
              try {
                await friendship.ready()
                this.emit('friendship', friendship)
                friendship.contact().emit('friendship', friendship)
              } catch (e) {
                this.emit('error', GError.from(e))
              }
            })
            break

          case 'login':
            puppet.on('login', async payload => {
              try {
                const contact = await this.ContactSelf.find({ id: payload.contactId })
                if (!contact) {
                  throw new Error('no contact found for id: ' + payload.contactId)
                }
                this.emit('login', contact)
              } catch (e) {
                this.emit('error', GError.from(e))
              }
            })
            break

          case 'logout':
            puppet.on('logout', async payload => {
              try {
                this.__readyState.inactive(true)
                const contact = await this.ContactSelf.find({ id: payload.contactId })
                if (contact) {
                  this.emit('logout', contact, payload.data)
                } else {
                  log.verbose('PuppetMixin',
                    '_setupPuppetEvents() logout event contact self not found for id: %s',
                    payload.contactId,
                  )
                }
              } catch (e) {
                this.emit('error', GError.from(e))
              }
            })
            break

          case 'message':
            puppet.on('message', async payload => {
              try {
                const msg = await this.Message.find({ id: payload.messageId })
                if (!msg) {
                  throw new Error('message not found for id: ' + payload.messageId)
                }
                this.emit('message', msg)

                const room     = msg.room()
                const listener = msg.listener()

                if (room) {
                  room.emit('message', msg)
                } else if (listener) {
                  listener.emit('message', msg)
                } else {
                  this.emit('error', GError.from('message without room and listener'))
                }
              } catch (e) {
                this.emit('error', GError.from(e))
              }
            })
            break

          case 'ready':
            puppet.on('ready', () => {
              log.silly('WechatyPuppetMixin', '_setupPuppetEvents() puppet.on(ready)')

              this.emit('ready')
              this.__readyState.active(true)
            })
            break

          case 'room-invite':
            puppet.on('room-invite', async payload => {
              const roomInvitation = this.RoomInvitation.load(payload.roomInvitationId)
              this.emit('room-invite', roomInvitation)
            })
            break

          case 'room-join':
            puppet.on('room-join', async payload => {
              try {
                const room = await this.Room.find({ id: payload.roomId })
                if (!room) {
                  throw new Error('no room found for id: ' + payload.roomId)
                }
                await room.sync()

                const inviteeListAll = await Promise.all(
                  payload.inviteeIdList.map(id => this.Contact.find({ id })),
                )
                const inviteeList = inviteeListAll.filter(c => !!c) as ContactInterface[]

                const inviter = await this.Contact.find({ id: payload.inviterId })
                if (!inviter) {
                  throw new Error('no inviter found for id: ' + payload.inviterId)
                }

                const date = timestampToDate(payload.timestamp)

                this.emit('room-join', room, inviteeList, inviter, date)
                room.emit('join', inviteeList, inviter, date)
              } catch (e) {
                this.emit('error', GError.from(e))
              }
            })
            break

          case 'room-leave':
            puppet.on('room-leave', async payload => {
              try {
                const room = await this.Room.find({ id: payload.roomId })
                if (!room) {
                  throw new Error('no room found for id: ' + payload.roomId)
                }

                /**
                 * See: https://github.com/wechaty/wechaty/pull/1833
                 */
                await room.sync()

                const leaverListAll = await Promise.all(
                  payload.removeeIdList.map(id => this.Contact.find({ id })),
                )
                const leaverList = leaverListAll.filter(c => !!c) as ContactInterface[]

                const remover = await this.Contact.find({ id: payload.removerId })
                if (!remover) {
                  throw new Error('no remover found for id: ' + payload.removerId)
                }
                const date = timestampToDate(payload.timestamp)

                this.emit('room-leave', room, leaverList, remover, date)
                room.emit('leave', leaverList, remover, date)

                // issue #254
                if (payload.removeeIdList.includes(puppet.currentUserId)) {
                  await puppet.dirtyPayload(PUPPET.type.Payload.Room, payload.roomId)
                  await puppet.dirtyPayload(PUPPET.type.Payload.RoomMember, payload.roomId)
                }
              } catch (e) {
                this.emit('error', GError.from(e))
              }
            })
            break

          case 'room-topic':
            puppet.on('room-topic', async payload => {
              try {
                const room = await this.Room.find({ id: payload.roomId })
                if (!room) {
                  throw new Error('no room found for id: ' + payload.roomId)
                }
                await room.sync()

                const changer = await this.Contact.find({ id: payload.changerId })
                if (!changer) {
                  throw new Error('no changer found for id: ' + payload.changerId)
                }
                const date = timestampToDate(payload.timestamp)

                this.emit('room-topic', room, payload.newTopic, payload.oldTopic, changer, date)
                room.emit('topic', payload.newTopic, payload.oldTopic, changer, date)
              } catch (e) {
                this.emit('error', GError.from(e))
              }
            })
            break

          case 'scan':
            puppet.on('scan', async payload => {
              this.__readyState.inactive(true)
              this.emit('scan', payload.qrcode || '', payload.status, payload.data)
            })
            break

          case 'reset':
            // Do not propagation `reset` event from puppet
            break

          case 'dirty':
            /**
             * https://github.com/wechaty/wechaty-puppet-service/issues/43
             */
            puppet.on('dirty', async ({ payloadType, payloadId }) => {
              try {
                switch (payloadType) {
                  case PUPPET.type.Payload.RoomMember:
                  case PUPPET.type.Payload.Contact:
                    await (await this.Contact.find({ id: payloadId }))?.sync()
                    break
                  case PUPPET.type.Payload.Room:
                    await (await this.Room.find({ id: payloadId }))?.sync()
                    break

                  /**
                   * Huan(202008): noop for the following
                   */
                  case PUPPET.type.Payload.Friendship:
                    // Friendship has no payload
                    break
                  case PUPPET.type.Payload.Message:
                    // Message does not need to dirty (?)
                    break

                  case PUPPET.type.Payload.Unspecified:
                  default:
                    throw new Error('unknown payload type: ' + payloadType)
                }
              } catch (e) {
                this.emit('error', GError.from(e))
              }
            })
            break

          default:
            /**
             * Check: The eventName here should have the type `never`
             */
            throw new Error('eventName ' + eventName + ' unsupported!')

        }
      }

      log.verbose('WechatyPuppetMixin', '_setupPuppetEvents() ... done')
    }

  }

  return PuppetMixin
}

type PuppetMixin = ReturnType<typeof puppetMixin>

type ProtectedPropertyPuppetMixin =
  | '__initPuppetInstance'
  | '__puppet'
  | '__readyState'
  | '__setupPuppetEvents'

export type {
  PuppetMixin,
  ProtectedPropertyPuppetMixin,
}
export {
  puppetMixin,
}
