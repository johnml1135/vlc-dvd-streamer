import Fastify from 'fastify'
import formbody from '@fastify/formbody'
import websocket from '@fastify/websocket'
import { createAppContext, type AppDeps, type AppServices } from './http/app-types.js'
import { registerApiRoutes } from './http/routes/api-routes.js'
import { registerStreamRoutes } from './http/routes/stream-routes.js'
import { registerUiRoutes } from './http/routes/ui-routes.js'

export async function buildApp(deps: AppDeps) {
  const app = Fastify()
  const context = createAppContext(deps)

  await app.register(formbody)
  await app.register(websocket)

  app.addHook('onClose', async () => {
    if (context.services.sessionManager) {
      await context.services.sessionManager.stopAll()
    }
  })

  await registerStreamRoutes(app, context)
  await registerUiRoutes(app, context)
  await registerApiRoutes(app, context)

  return app
}

export type { AppDeps, AppServices }