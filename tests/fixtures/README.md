Synthetic video: two seconds of black 32×32 H.264 frames and a 440 Hz AAC tone, split into two HLS MPEG-TS segments. No site content is included.

Generated with FFmpeg:

```
ffmpeg -f lavfi -i color=c=black:s=32x32:r=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 -c:v libx264 -pix_fmt yuv420p -g 25 -keyint_min 25 -sc_threshold 0 -c:a aac -b:a 32k -f hls -hls_time 1 -hls_playlist_type vod -hls_segment_filename sample-%02d.ts sample.m3u8
```
