import Promise from 'bluebird';
import { getCassandraClient } from '../../common/cassandra';
import config from '../../common/config';
import { toCassandraUuid, toProtobufUuid, toProtobufTimestamp } from '../common/protobuf-conversions';
import { NotImplementedError } from '../common/grpc-errors';
import { GetRelatedVideosResponse, SuggestedVideoPreview } from './protos';

/**
 * Gets a list of videos related to another video.
 */
export function getRelatedVideos(call, cb) {
  // Pick appropriate implementation
  let fn = config.get('dseEnabled') === true
    ? getRelatedVideosWithDseSearch
    : getRelatedVideosByTag;

  // Invoke async function, wrap with bluebird Promise, and invoke callback when finished
  return Promise.resolve(fn(call)).asCallback(cb);
};

/**
 * Helper function that returns a new empty response.
 */
function emptyResponse(videoId) {
  return new GetRelatedVideosResponse({
    videoId,
    videos: [],
    pagingState: ''
  });
}

/**
 * Helper function to convert a Cassandra row to a SuggestedVideoPreview object.
 */
function toSuggestedVideoPreview(row) {
  return new SuggestedVideoPreview({
    videoId: toProtobufUuid(row.videoid),
    addedDate: toProtobufTimestamp(row.added_date),
    name: row.name,
    previewImageLocation: row.preview_image_location,
    userId: toProtobufUuid(row.userid)
  });
}

/**
 * Number of videos to return when doing related videos by tag.
 */
const RELATED_BY_TAG_RETURN_COUNT = 4;

/**
 * Gets related videos based on the tags in the specified video. Does not support paging.
 */
async function getRelatedVideosByTag(call) {
  // TODO: Stop "cheating" and using data directly from other services

  let { request } = call;
  let videoId = toCassandraUuid(request.videoId);

  // Get tags for the given video
  let client = getCassandraClient();
  let tagsResultSet = await client.executeAsync('SELECT tags FROM videos WHERE videoid = ?', [ videoId ]);

  // Make sure we have tags
  let tagRow = tagsResultSet.first();
  if (tagRow === null) {
    return emptyResponse();
  }

  let { tags } = tagRow;
  if (tags.length === 0) {
    return emptyResponse();
  }

  // Use the number of results we want to return * 2 when querying so that we can account for potentially having
  // to filter out the video Id we're looking up, as well as duplicates
  const pageSize = RELATED_BY_TAG_RETURN_COUNT * 2;

  // Kick off queries in parallel for the tags
  let inFlight = [];
  let videos = {};
  let videoCount = 0;
  for (let i = 0; i < tags.length; i++) {
    let tag = tags[i];
    let promise = client.executeAsync('SELECT * FROM videos_by_tag WHERE tag = ? LIMIT ?', [ tag, pageSize ]);
    inFlight.push(promise);

    // If we don't have at least three in-flight queries and this isn't the last tag, keep kicking off queries
    if (inFlight.length < 3 && i !== tags.length - 1) {
      continue;
    }

    // Otherwise, wait for all in-flight queries to complete
    let resultSets = await Promise.all(inFlight);

    // Process the results
    for (let resultSet of resultSets) {
      for (let row of resultSet.rows) {
        let video = toSuggestedVideoPreview(row);

        // Skip self
        if (video.videoId.value === request.videoId.value) {
          continue;
        }

        // Skip it if we already have it in the results
        if (videos.hasOwnProperty(video.videoId.value)) {
          continue;
        }

        // Add to results
        videos[video.videoId.value] = video;
        videoCount++;

        // Do we have enough results?
        if (videoCount >= RELATED_BY_TAG_RETURN_COUNT)
          break;
      }

      // Do we have enough results?
      if (videoCount >= RELATED_BY_TAG_RETURN_COUNT)
        break;
    }

    // Do we have enough results?
    if (videoCount >= RELATED_BY_TAG_RETURN_COUNT)
      break;

    // Not enough yet so clear the in-flight query list and start again
    inFlight = [];
  }

  // Return the response
  return new GetRelatedVideosResponse({
    videoId: request.videoId,
    videos: Object.keys(videos).map(id => videos[id]),
    pagingState: ''   // Does not support paging
  });
}

/**
 * Gets related videos using DSE Search "More Like This" functionality.
 */
async function getRelatedVideosWithDseSearch(call) {
  throw new NotImplementedError('Not implemented');
}