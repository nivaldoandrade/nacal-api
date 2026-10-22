import { URL } from 'node:url';

import { Meal } from '@application/entities/Meal';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { s3Client } from '@infra/clients/s3Client';
import { Injectable } from '@kernel/decorators/Injectable';
import { AppConfig } from '@shared/config/AppConfig';
import { randomUUID } from 'node:crypto';

const EXPIRES_PRESIGNED_POST = 5 * 60; //5MIN

@Injectable()
export class MealFileStorageGateway {

  constructor(private readonly config: AppConfig) { }

  static generateInputFileKey({
    accountId,
    mimeType,
  }: MealFileStorageGateway.GenerateInputFileKeyParams): string {
    const { extension } = Meal.getInputFile(mimeType);
    const filename = randomUUID();

    return `${accountId}/${filename}.${extension}`;
  }

  getFileURL(fileKey: string): string {
    const url = new URL(
      fileKey,
      `https://${this.config.cdn.mealsCDN}`,
    );

    return url.toString();
  }

  async getObjectBytes(fileKey: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: this.config.storage.mealsBucketName,
      Key: fileKey,
    });

    const { Body } = await s3Client.send(command);

    if (!Body) {
      throw new Error(`Cannot read file: ${fileKey}.`);
    }

    return Buffer.from(await Body.transformToByteArray());
  }

  async deleteObject(fileKey: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.config.storage.mealsBucketName,
      Key: fileKey,
    });

    await s3Client.send(command);
  }

  async getMetadata(fileKey: string): Promise<MealFileStorageGateway.GetMetadada['result']> {
    const command = new HeadObjectCommand({
      Bucket: this.config.storage.mealsBucketName,
      Key: fileKey,
    });

    const { Metadata = {} } = await s3Client.send(command);

    const metadada = Metadata as MealFileStorageGateway.GetMetadada['HeadObjectCommandResult'];

    if (!metadada.mealid || !metadada.accountid) {
      throw new Error(`Cannot get metadata file: ${fileKey}.`);
    }

    return {
      mealId: metadada.mealid,
      accountId: metadada.accountid,
    };

  }

  async getPOST({
    accountId,
    mealId,
    inputFileKey,
    mimeType,
    fileSize,
  }: MealFileStorageGateway.GetPOST['params']): Promise<MealFileStorageGateway.GetPOST['result']> {
    const { url, fields } = await createPresignedPost(s3Client, {
      Bucket: this.config.storage.mealsBucketName,
      Key: inputFileKey,
      Expires: EXPIRES_PRESIGNED_POST,
      Conditions: [
        {
          'Content-Type': mimeType,
        },
        ['starts-with', '$x-amz-meta-mealid', ''],
        ['starts-with', '$x-amz-meta-accountid', ''],
        ['content-length-range', fileSize, fileSize],
      ],
      Fields: {
        'Content-Type': mimeType,
        'x-amz-meta-mealid': mealId,
        'x-amz-meta-accountid': accountId,
      },
    });

    const uploadSignature = Buffer.from(
      JSON.stringify({ url, fields }),
    ).toString('base64');

    return {
      uploadSignature,
    };
  }
}

export namespace MealFileStorageGateway {

  export type GenerateInputFileKeyParams = {
    accountId: string;
    mimeType: Meal.MimeType;
  }

  export type GetPOST = {
    params: {
      mealId: string;
      accountId: string;
      inputFileKey: string;
      mimeType: Meal.MimeType;
      fileSize: number;
    },
    result: {
      uploadSignature: string
    }
  }

  export type GetMetadada = {
    HeadObjectCommandResult: {
      mealid: string;
      accountid: string;
    }

    result: {
      mealId: string;
      accountId: string;
    }

  }
}
