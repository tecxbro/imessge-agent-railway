import { afterEach, describe, expect, it } from "vitest";

import {
  createSpectrumApp,
  type SpectrumApp,
} from "../../src/transport/spectrum.js";
import { normalizeIMessageSender } from "../../src/transport/sender-identity.js";
import {
  DEFAULT_READ_RECEIPT_DELAY_MS,
  DEFAULT_TYPING_START_DELAY_MS,
} from "../../src/transport/read-receipts.js";

const liveConfiguration = {
  enabled: process.env["SPECTRUM_LIVE_TEST"] === "true",
  expectedSender: process.env["SPECTRUM_LIVE_EXPECTED_SENDER"],
  expectedText: process.env["SPECTRUM_LIVE_EXPECTED_TEXT"],
  projectId: process.env["SPECTRUM_LIVE_PROJECT_ID"],
  projectSecret: process.env["SPECTRUM_LIVE_PROJECT_SECRET"],
  replyText: process.env["SPECTRUM_LIVE_REPLY_TEXT"],
};

const configured =
  liveConfiguration.enabled &&
  Object.entries(liveConfiguration)
    .filter(([key]) => key !== "enabled")
    .every(([, value]) => typeof value === "string" && value.length > 0);

let app: SpectrumApp | undefined;

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

describe.skipIf(!configured)("live Spectrum Cloud authorized DM", () => {
  it(
    "receives the expected inbound text and sends one reply",
    async () => {
      const projectId = liveConfiguration.projectId;
      const projectSecret = liveConfiguration.projectSecret;
      const expectedSender = liveConfiguration.expectedSender;
      const expectedText = liveConfiguration.expectedText;
      const replyText = liveConfiguration.replyText;

      if (
        projectId === undefined ||
        projectSecret === undefined ||
        expectedSender === undefined ||
        expectedText === undefined ||
        replyText === undefined
      ) {
        throw new Error(
          "Set every SPECTRUM_LIVE_* variable before enabling the live DM smoke test.",
        );
      }

      const normalizedExpectedSender = normalizeIMessageSender({
        id: expectedSender,
      }).address;
      app = await createSpectrumApp({ projectId, projectSecret });

      let timeout: NodeJS.Timeout | undefined;
      try {
        const inbound = (async () => {
          for await (const [space, message] of app!.messages) {
            if (
              message.platform !== "imessage" ||
              message.direction !== "inbound" ||
              message.content.type !== "text" ||
              message.content.text !== expectedText
            ) {
              continue;
            }

            let senderAddress: string;
            try {
              senderAddress = normalizeIMessageSender(message.sender).address;
            } catch {
              continue;
            }

            if (senderAddress === normalizedExpectedSender) {
              return { message, space };
            }
          }

          throw new Error(
            "Spectrum message stream stopped before the expected DM arrived.",
          );
        })();
        const expired = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                "Timed out waiting for the configured authorized Spectrum DM.",
              ),
            );
          }, 60_000);
        });

        const { message, space } = await Promise.race([inbound, expired]);
        let typing = false;
        try {
          // Manual protected check: watch the sending device transition through
          // Delivered -> Read -> typing before the reply becomes visible.
          await wait(DEFAULT_READ_RECEIPT_DELAY_MS);
          await message.read();
          await wait(DEFAULT_TYPING_START_DELAY_MS);
          await space.startTyping();
          typing = true;
          await wait(1_500);
          await space.stopTyping();
          typing = false;
          await space.send(replyText);
        } finally {
          if (typing) {
            await space.stopTyping().catch(() => undefined);
          }
        }

        expect(space.id.length).toBeGreaterThan(0);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    },
    90_000,
  );
});
