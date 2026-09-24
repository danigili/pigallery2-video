import {Pipe, PipeTransform} from '@angular/core';
import {MediaDTO, MediaDTOUtils} from '../../../common/entities/MediaDTO';
import {PhotoDTO} from '../../../common/entities/PhotoDTO';
import {MediaGroup} from '../ui/gallery/navigator/sorting.service';

/**
 * Lists photos and videos (e.g., for the map).
 * Videos are returned as PhotoDTO too, as their metadata can also contain positionData.
 */
@Pipe({
    name: 'photosAndVideos',
    standalone: true
})
export class MediaFilterPipe implements PipeTransform {
  transform(mediaGroups: MediaGroup[]): PhotoDTO[] | null {
    if (!mediaGroups) {
      return null;
    }
    const ret = [];
    for (let i = 0; i < mediaGroups.length; ++i) {
      ret.push(...mediaGroups[i].media.filter((m: MediaDTO): boolean =>
          MediaDTOUtils.isPhoto(m) || MediaDTOUtils.isVideo(m)
      ) as PhotoDTO[]);
    }
    return ret;
  }
}
