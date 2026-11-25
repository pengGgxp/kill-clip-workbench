import ctypes
import sys

import vapoursynth as vs


def write_plane(stream, frame, plane, width, height):
    stride = frame.get_stride(plane)
    address = frame.get_read_ptr(plane).value
    if stride == width:
        stream.write(ctypes.string_at(address, width * height))
        return
    for row in range(height):
        stream.write(ctypes.string_at(address + row * stride, width))


def render_batch(core, frames, planes, width, height, fps, start, stop):
    def fill_frame(n, f):
        frame = f.copy()
        data = frames[n]
        offset = 0
        for plane, (row_bytes, rows) in enumerate(planes):
            stride = frame.get_stride(plane)
            address = frame.get_write_ptr(plane).value
            if stride == row_bytes:
                size = row_bytes * rows
                ctypes.memmove(address, data[offset:offset + size], size)
                offset += size
            else:
                for row in range(rows):
                    end = offset + row_bytes
                    ctypes.memmove(address + row * stride, data[offset:end], row_bytes)
                    offset = end
        return frame

    template = core.std.BlankClip(
        width=width, height=height, length=len(frames), fpsnum=fps,
        format=vs.YUV420P8,
    )
    clip = template.std.ModifyFrame(clips=template, selector=fill_frame)
    super_clip = core.mvu.Super(clip, blksize=8, overlap=4, pel=2)
    vectors = core.mvu.AnalyseMany(super_clip, radius=1)
    blurred = core.mvu.FlowBlur(clip, super_clip, vectors, blur=50.0, prec=1)
    stream = sys.stdout.buffer
    for frame in blurred[start:stop].frames(prefetch=4, backlog=4):
        for plane, (row_bytes, rows) in enumerate(planes):
            write_plane(stream, frame, plane, row_bytes, rows)


def main(width, height, fps, count):
    core = vs.core
    core.num_threads = min(8, core.num_threads)
    core.max_cache_size = 384
    planes = [(width, height), (width // 2, height // 2), (width // 2, height // 2)]
    frame_size = sum(row_bytes * rows for row_bytes, rows in planes)
    stream = sys.stdin.buffer

    def read_frame():
        frame = stream.read(frame_size)
        if len(frame) != frame_size:
            raise EOFError("Incomplete video frame from FFmpeg")
        return frame

    batch_size = 12
    previous = None
    current = read_frame()
    for first in range(0, count, batch_size):
        size = min(batch_size, count - first)
        frames = [current, *(read_frame() for _ in range(size - 1))]
        # Keep the neighboring frame on each side across internal batch boundaries.
        context = [previous] if previous is not None else []
        last = frames[-1]
        if first + size < count:
            current = read_frame()
            frames.append(current)
        start = len(context)
        if len(context) + len(frames) == 1:
            frames.append(last)
        render_batch(core, context + frames, planes, width, height, fps, start, start + size)
        previous = last


if __name__ == "__main__":
    main(*map(int, sys.argv[1:]))
