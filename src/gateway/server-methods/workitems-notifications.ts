// In-app work item notifications: workitems.notifications.list (observe) and
// workitems.notifications.markRead (attach). Both act only on the caller's own records; the
// principal comes from the connection, never from the request. A record is listed only while
// the caller may still read its item, so a revoked reader sees nothing stale. Marking read is an
// explicit action; opening the item does not do it.
import type { GatewayRequestHandlers } from "./types.js";
import { canRead } from "../../workitems/access.js";
import { listNotifications, markNotificationRead } from "../../workitems/notifications-store.js";
import { loadWorkQueuePolicy } from "../../workitems/policy.js";
import { readWorkItem } from "../../workitems/store.js";
import { actorFor, fail, projectOf, valid } from "./workitems-shared.js";

export const workitemsNotificationsHandlers: GatewayRequestHandlers = {
  "workitems.notifications.list": ({ params, respond, client }) => {
    if (!valid("workitems.notifications.list", params, respond)) {
      return;
    }
    const p = params as { projectId: string; unreadOnly?: boolean };
    try {
      const project = projectOf(p.projectId);
      const policy = loadWorkQueuePolicy(project);
      const actor = actorFor(client);
      const now = new Date();
      const seen = new Map<string, boolean>();
      const visible = (itemId: string) => {
        let ok = seen.get(itemId);
        if (ok === undefined) {
          const item = readWorkItem(project.id, itemId);
          ok = item !== null && canRead(item, actor, policy, now);
          seen.set(itemId, ok);
        }
        return ok;
      };
      respond(true, {
        notifications: listNotifications(project.id, actor.id, {
          unreadOnly: p.unreadOnly,
          visible,
        }),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.notifications.markRead": ({ params, respond, client }) => {
    if (!valid("workitems.notifications.markRead", params, respond)) {
      return;
    }
    const p = params as { projectId: string; id: string };
    try {
      const project = projectOf(p.projectId);
      respond(true, {
        notification: markNotificationRead(project.id, actorFor(client).id, p.id, new Date()),
      });
    } catch (err) {
      fail(respond, err);
    }
  },
};
