import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";

import { z } from "zod";

import { createDataCipher, type DataCipher } from "../security/data-cipher.js";

const e164PhoneNumber = z.string().regex(/^\+[1-9]\d{7,14}$/u);
const privateText = z.string().trim().min(1).max(16_384);

const photonSetupResultSchema = z.strictObject({
  photonDeviceBearerToken: privateText,
  photonProjectId: z.string().trim().min(1).max(256),
  spectrumProjectSecret: privateText,
  ownerPhoneNumber: e164PhoneNumber,
  assignedIMessageNumber: e164PhoneNumber,
});

const storedPhotonCredentialsSchema = z.strictObject({
  version: z.literal(1),
  photonProjectId: z.string().trim().min(1).max(256),
  photonDeviceBearerTokenCiphertext: z.string().min(1).max(32_768),
  spectrumProjectSecretCiphertext: z.string().min(1).max(32_768),
  ownerPhoneNumber: e164PhoneNumber,
  assignedIMessageNumber: e164PhoneNumber,
});

export type PhotonSetupResult = z.infer<typeof photonSetupResultSchema>;

export class PhotonCredentialsError extends Error {
  public readonly code = "PHOTON_CREDENTIALS_INVALID";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PhotonCredentialsError";
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new PhotonCredentialsError(
      "Photon credential storage must be a private directory on the persistent disk.",
    );
  }
  await chmod(directory, 0o700);
}

async function ensurePrivateCredentialFile(path: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new PhotonCredentialsError(
      "Photon credentials must be stored in a private regular file.",
    );
  }
  await chmod(path, 0o600);
}

/**
 * Private disk-backed storage for the result of Photon device setup.
 *
 * The management bearer token and Spectrum project secret are encrypted with
 * APP_ENCRYPTION_KEY before the JSON file is written. The store is deliberately
 * independent from the operator dashboard so callers cannot serialize its
 * contents into user-facing status responses.
 */
export class PhotonCredentialsStore {
  private readonly directory: string;
  private readonly path: string;
  private readonly cipher: DataCipher;

  public constructor(options: {
    directory: string;
    encryptionKey: string;
  }) {
    if (!isAbsolute(options.directory)) {
      throw new PhotonCredentialsError(
        "Photon credential storage requires an explicit absolute persistent-disk directory.",
      );
    }
    this.directory = resolve(options.directory);
    if (this.directory === parse(this.directory).root) {
      throw new PhotonCredentialsError(
        "Photon credential storage cannot use a filesystem root.",
      );
    }
    this.path = resolve(this.directory, "credentials.json");
    this.cipher = createDataCipher(options.encryptionKey);
  }

  public async load(): Promise<PhotonSetupResult | undefined> {
    let serialized: string;
    try {
      await ensurePrivateCredentialFile(this.path);
      serialized = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      if (error instanceof PhotonCredentialsError) {
        throw error;
      }
      throw new PhotonCredentialsError(
        "Photon credentials could not be read from the persistent disk.",
        { cause: error },
      );
    }

    try {
      const stored = storedPhotonCredentialsSchema.parse(
        JSON.parse(serialized) as unknown,
      );
      return photonSetupResultSchema.parse({
        photonDeviceBearerToken: this.cipher.decrypt(
          stored.photonDeviceBearerTokenCiphertext,
        ),
        photonProjectId: stored.photonProjectId,
        spectrumProjectSecret: this.cipher.decrypt(
          stored.spectrumProjectSecretCiphertext,
        ),
        ownerPhoneNumber: stored.ownerPhoneNumber,
        assignedIMessageNumber: stored.assignedIMessageNumber,
      });
    } catch (error) {
      throw new PhotonCredentialsError(
        "Stored Photon credentials are invalid or cannot be decrypted with APP_ENCRYPTION_KEY.",
        { cause: error },
      );
    }
  }

  public async save(result: PhotonSetupResult): Promise<void> {
    const validated = photonSetupResultSchema.parse(result);
    const stored = storedPhotonCredentialsSchema.parse({
      version: 1,
      photonProjectId: validated.photonProjectId,
      photonDeviceBearerTokenCiphertext: this.cipher.encrypt(
        validated.photonDeviceBearerToken,
      ),
      spectrumProjectSecretCiphertext: this.cipher.encrypt(
        validated.spectrumProjectSecret,
      ),
      ownerPhoneNumber: validated.ownerPhoneNumber,
      assignedIMessageNumber: validated.assignedIMessageNumber,
    });
    const temporaryPath = resolve(
      this.directory,
      `.credentials-${randomUUID()}.tmp`,
    );

    try {
      await ensurePrivateDirectory(this.directory);
      await writeFile(temporaryPath, `${JSON.stringify(stored)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
      await ensurePrivateCredentialFile(this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof PhotonCredentialsError) {
        throw error;
      }
      throw new PhotonCredentialsError(
        "Photon credentials could not be saved to the persistent disk.",
        { cause: error },
      );
    }
  }
}
