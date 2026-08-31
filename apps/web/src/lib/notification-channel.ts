/**
 * BLASTI Notification Channel Setup
 * 
 * Creates a high-priority notification channel for the "Turn Called" alert.
 * On Android (via Capacitor), this uses LocalNotifications.createChannel()
 * to create a channel with max importance and custom alarm sound.
 * 
 * On web, we use the Notification API with appropriate options.
 * 
 * IMPORTANT: Capacitor plugins are accessed via window.Capacitor.Plugins
 * to avoid bundling errors in the web project (the @capacitor/* packages
 * are only installed in apps/mobile).
 */

interface NotificationChannelConfig {
  id: string;
  name: string;
  importance: number;
  sound?: string;
  vibration?: boolean;
  lights?: boolean;
  lightColor?: string;
}

const BLASTI_TURN_CHANNEL: NotificationChannelConfig = {
  id: 'blasti-turn-alert',
  name: 'BLASTI Turn Alert',
  importance: 5, // Max importance — shows as heads-up notification
  sound: 'blasti_alarm.wav',
  vibration: true,
  lights: true,
  lightColor: '#10b981',
};

let channelCreated = false;

/**
 * Check if we're running inside a Capacitor native shell.
 */
function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as any)?.Capacitor;
  if (!cap) return false;
  if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform();
  if (typeof cap.isNative === 'boolean') return cap.isNative;
  return false;
}

/**
 * Get the Capacitor LocalNotifications plugin via the global runtime.
 * This avoids importing @capacitor/local-notifications (which doesn't
 * exist in the web package and would cause bundling errors).
 */
function getLocalNotificationsPlugin(): any | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as any)?.Capacitor;
  if (!cap) return null;
  
  // Access pre-registered plugin via Capacitor.Plugins
  // (Do NOT use registerPlugin() as it may trigger dynamic imports that fail on web)
  const plugin = cap.Plugins?.LocalNotifications;
  return plugin || null;
}

export async function setupTurnAlertChannel(): Promise<void> {
  if (channelCreated) return;

  if (isCapacitorNative()) {
    try {
      const LocalNotifications = getLocalNotificationsPlugin();
      if (LocalNotifications?.createChannel) {
        await LocalNotifications.createChannel(BLASTI_TURN_CHANNEL);
        console.log('[NotificationChannel] Created high-priority channel:', BLASTI_TURN_CHANNEL.id);
      }
    } catch {
      console.log('[NotificationChannel] Capacitor channel creation failed, skipping');
    }
  } else {
    console.log('[NotificationChannel] Web environment, skipping Capacitor channel creation');
  }

  channelCreated = true;
}

export async function scheduleTurnNotification(title: string, body: string, ticketNumber: string): Promise<void> {
  // Try Capacitor LocalNotifications on native platforms
  if (isCapacitorNative()) {
    try {
      const LocalNotifications = getLocalNotificationsPlugin();
      if (LocalNotifications?.schedule) {
        await LocalNotifications.schedule({
          notifications: [{
            title,
            body,
            id: Date.now() % 100000,
            channelId: BLASTI_TURN_CHANNEL.id,
            sound: 'blasti_alarm.wav',
            smallIcon: 'ic_notification',
            largeIcon: 'blasti_icon',
            extra: { ticketNumber, type: 'TURN_CALLED' },
          }],
        });
        return;
      }
    } catch {
      // Fallback to web Notification API below
    }
  }

  // Web Notification API fallback
  if (typeof window !== 'undefined' && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      const notification = new Notification(title, {
        body,
        icon: '/logo-192.png',
        badge: '/blasti-icon.png',
        tag: 'blasti-turn-alert',
        requireInteraction: true, // Stay visible until user dismisses
        silent: false,
      });
      
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } else if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        // Retry
        scheduleTurnNotification(title, body, ticketNumber);
      }
    }
  }
}

export { BLASTI_TURN_CHANNEL };
