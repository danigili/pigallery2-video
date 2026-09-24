/* eslint-disable @typescript-eslint/no-var-requires */
import * as sharp from 'sharp';
import {Metadata, Sharp, SharpOptions} from 'sharp';
import {Logger} from '../../Logger';
import {FfmpegCommand, FfprobeData, FfprobeStream} from 'fluent-ffmpeg';
import {FFmpegFactory} from '../FFmpegFactory';
import {ExtensionDecorator} from '../extension/ExtensionDecorator';


sharp.cache(false);

export class PhotoWorker {
  private static videoRenderer: (input: MediaRendererInput) => Promise<void> = null;

  public static render(input: SvgRendererInput | MediaRendererInput): Promise<void> {
    if (input.type === ThumbnailSourceType.Photo) {
      return this.renderFromImage(input);
    }
    if (input.type === ThumbnailSourceType.Video) {
      return this.renderFromVideo(input as MediaRendererInput);
    }
    throw new Error('Unsupported media type to render thumbnail:' + input.type);
  }

  public static renderFromImage(input: SvgRendererInput | MediaRendererInput, dryRun = false): Promise<void> {
    return ImageRendererFactory.render(input, dryRun);
  }

  public static renderFromVideo(input: MediaRendererInput): Promise<void> {
    if (PhotoWorker.videoRenderer === null) {
      PhotoWorker.videoRenderer = VideoRendererFactory.build();
    }
    return PhotoWorker.videoRenderer(input);
  }
}

export enum ThumbnailSourceType {
  Photo = 1,
  Video = 2,
}

interface RendererInput {
  type: ThumbnailSourceType;
  size: number;
  makeSquare?: boolean;
  outPath?: string;
  quality: number;
  useLanczos3: boolean;
  cut?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export interface MediaRendererInput extends RendererInput {
  mediaPath: string;
  smartSubsample: boolean;
  sharpOptions: SharpOptions;
  animate: boolean; // animates the output. Used for Gifs
}

export interface SvgRendererInput extends RendererInput {
  svgString: string;
}

export class VideoRendererFactory {
  // PQ (HDR10, Dolby Vision) and HLG (iPhone, Android phones) transfer characteristics
  private static readonly HDR_TRANSFERS = ['smpte2084', 'arib-std-b67'];
  // values that ffprobe reports and zscale also understands
  private static readonly ZSCALE_PRIMARIES = ['bt709', 'bt2020', 'smpte432'];
  private static readonly ZSCALE_MATRICES = ['bt709', 'bt2020nc', 'bt2020c'];
  // BT.2408 HDR reference white (cd/m2). Maps the HDR diffuse white to SDR white
  private static readonly HDR_REFERENCE_WHITE = 203;

  private static toneMappingSupported: Promise<boolean> = null;

  public static build(): (input: MediaRendererInput) => Promise<void> {
    const ffmpeg = FFmpegFactory.get();
    return async (input: MediaRendererInput): Promise<void> => {
      Logger.silly('[FFmpeg] rendering thumbnail: ' + input.mediaPath);

      const data = await new Promise<FfprobeData>((resolve, reject): void => {
        ffmpeg(input.mediaPath).ffprobe((err: Error, d: FfprobeData): void => {
          if (!!err || !d) {
            return reject('[FFmpeg] ' + err?.toString());
          }
          resolve(d);
        });
      });

      const stream = data.streams.find((s) =>
        s.width && s.height && !isNaN(s.width) && !isNaN(s.height));
      if (!stream) {
        throw new Error('[FFmpeg] Can not read video dimension. ' + input.mediaPath);
      }

      let duration = Number(stream.duration);
      if (isNaN(duration)) {
        duration = Number(data.format?.duration);
      }
      const seekTime = isNaN(duration) ? 0 : duration * 0.1;

      // scale before tone mapping, so the costly float conversion runs on the small frame
      const filters = [VideoRendererFactory.getScaleFilter(input, stream.width, stream.height)];
      if (VideoRendererFactory.isHDR(stream)) {
        if (await VideoRendererFactory.isToneMappingSupported(ffmpeg)) {
          filters.push(...VideoRendererFactory.getToneMappingFilters(stream));
        } else {
          Logger.warn('[FFmpeg] HDR video found, but ffmpeg has no zscale/tonemap filter (needs libzimg). Thumbnail will look washed out: ' + input.mediaPath);
        }
      }

      await new Promise<void>((resolve, reject): void => {
        const command: FfmpegCommand = ffmpeg(input.mediaPath);
        let executedCmd = '';
        command
          .on('start', (cmd): void => {
            executedCmd = cmd;
          })
          .on('end', (): void => {
            resolve();
          })
          .on('error', (e): void => {
            reject('[FFmpeg] ' + e.toString() + ' executed: ' + executedCmd);
          })
          .seekInput(seekTime)
          .videoFilters(filters)
          .frames(1)
          .outputOptions(['-qscale:v 50'])
          .save(input.outPath);
      });
    };
  }

  public static isHDR(stream: FfprobeStream): boolean {
    return VideoRendererFactory.HDR_TRANSFERS.includes(stream.color_transfer);
  }

  /**
   * Converts HDR (PQ or HLG, BT.2020) frames to SDR BT.709.
   * Without it, the 10-bit HDR frame is only truncated to 8 bit and the thumbnail looks washed out.
   */
  public static getToneMappingFilters(stream: FfprobeStream): string[] {
    const primaries = VideoRendererFactory.ZSCALE_PRIMARIES.includes(stream.color_primaries) ? stream.color_primaries : 'bt2020';
    const matrix = VideoRendererFactory.ZSCALE_MATRICES.includes(stream.color_space) ? stream.color_space : 'bt2020nc';
    const range = stream.color_range === 'pc' ? 'full' : 'limited';
    return [
      `zscale=tin=${stream.color_transfer}:pin=${primaries}:min=${matrix}:rin=${range}:t=linear:npl=${VideoRendererFactory.HDR_REFERENCE_WHITE}`,
      'format=gbrpf32le',
      'zscale=p=bt709',
      // mobius keeps the diffuse range untouched and only compresses the highlights
      'tonemap=tonemap=mobius:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p',
    ];
  }

  private static getScaleFilter(input: MediaRendererInput, width: number, height: number): string {
    if (input.makeSquare === false) {
      return width < height
        ? `scale=w=${Math.min(input.size, width)}:h=trunc(ow/a/2)*2`
        : `scale=w=trunc(oh*a/2)*2:h=${Math.min(input.size, height)}`;
    }
    return `scale=w=${input.size}:h=${input.size}`;
  }

  private static isToneMappingSupported(ffmpeg: (path?: string) => FfmpegCommand): Promise<boolean> {
    if (VideoRendererFactory.toneMappingSupported === null) {
      VideoRendererFactory.toneMappingSupported = new Promise<boolean>((resolve): void => {
        ffmpeg().availableFilters((err, filters): void => {
          resolve(!err && !!filters?.zscale && !!filters?.tonemap);
        });
      });
    }
    return VideoRendererFactory.toneMappingSupported;
  }
}

export class ImageRendererFactory {

  @ExtensionDecorator(e => e.gallery.ImageRenderer.render)
  public static async render(input: MediaRendererInput | SvgRendererInput, dryRun = false): Promise<void> {

    let image: Sharp;
    if ((input as MediaRendererInput).mediaPath) {
      Logger.silly(
        '[SharpRenderer] rendering photo:' +
        (input as MediaRendererInput).mediaPath +
        ', size:' +
        input.size
      );
      image = sharp((input as MediaRendererInput).mediaPath, {
        failOnError: false,
        animated: (input as MediaRendererInput).animate, ...((input as MediaRendererInput).sharpOptions || {})
      });
    } else {
      const svg_buffer = Buffer.from((input as SvgRendererInput).svgString);
      image = sharp(svg_buffer, {density: 450});
    }
    image.rotate();
    const metadata: Metadata = await image.metadata();
    const kernel =
      input.useLanczos3 === true
        ? sharp.kernel.lanczos3
        : sharp.kernel.nearest;

    if (input.cut) {
      image.extract(input.cut);
    }
    if (input.makeSquare === false) {
      if (metadata.height > metadata.width) {
        image.resize(Math.min(input.size, metadata.width), null, {
          kernel,
        });
      } else {
        image.resize(null, Math.min(input.size, metadata.height), {
          kernel,
        });
      }
    } else {
      image.resize(input.size, input.size, {
        kernel,
        position: sharp.gravity.centre,
        fit: 'cover',
      });
    }
    let processedImg: sharp.Sharp;
    if ((input as MediaRendererInput).mediaPath) {
      processedImg = image.webp({
        effort: 6,
        quality: input.quality,
        smartSubsample: (input as MediaRendererInput).smartSubsample
      });
    } else {
      if ((input as SvgRendererInput).svgString) {
        processedImg = image.png({effort: 6, quality: input.quality});
      }
    }
    // do not save to file
    if (dryRun) {
      await processedImg.toFormat('webp').toBuffer();
      return;
    }
    await processedImg.toFile(input.outPath);

  }
}
