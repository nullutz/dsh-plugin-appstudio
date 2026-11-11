"""Check that Mesa can create an accelerated OpenGL context in WSL."""

import ctypes as C


def supports_d3d12():
    egl = C.CDLL('libEGL.so.1')
    gl = C.CDLL('libGL.so.1')
    pointer = C.c_void_p
    integer = C.c_int
    attributes = C.POINTER(integer)

    egl.eglGetPlatformDisplay.argtypes = (C.c_uint, pointer, pointer)
    egl.eglGetPlatformDisplay.restype = pointer
    egl.eglInitialize.argtypes = (pointer, attributes, attributes)
    egl.eglBindAPI.argtypes = (C.c_uint,)
    egl.eglChooseConfig.argtypes = (pointer, attributes, C.POINTER(pointer), integer, attributes)
    egl.eglCreatePbufferSurface.argtypes = (pointer, pointer, attributes)
    egl.eglCreatePbufferSurface.restype = pointer
    egl.eglCreateContext.argtypes = (pointer, pointer, pointer, attributes)
    egl.eglCreateContext.restype = pointer
    egl.eglMakeCurrent.argtypes = (pointer, pointer, pointer, pointer)
    egl.eglDestroyContext.argtypes = (pointer, pointer)
    egl.eglDestroySurface.argtypes = (pointer, pointer)
    egl.eglTerminate.argtypes = (pointer,)
    gl.glGetString.argtypes = (C.c_uint,)
    gl.glGetString.restype = C.c_char_p

    egl_none = 0x3038
    display = egl.eglGetPlatformDisplay(0x31DD, None, None)  # EGL_PLATFORM_SURFACELESS_MESA
    if not display or not egl.eglInitialize(display, None, None):
        return False

    config, count = pointer(), integer()
    surface = context = None
    try:
        if not egl.eglBindAPI(0x30A2):  # EGL_OPENGL_API
            return False
        config_attrs = (integer * 5)(0x3033, 1, 0x3040, 8, egl_none)  # Pbuffer and OpenGL
        if not egl.eglChooseConfig(display, config_attrs, C.byref(config), 1, C.byref(count)) or not count.value:
            return False
        surface = egl.eglCreatePbufferSurface(display, config, (integer * 5)(0x3057, 1, 0x3056, 1, egl_none))
        context = egl.eglCreateContext(display, config, None, (integer * 1)(egl_none))
        if not surface or not context or not egl.eglMakeCurrent(display, surface, surface, context):
            return False
        renderer = (gl.glGetString(0x1F01) or b'').decode('ascii', errors='ignore').lower()  # GL_RENDERER
        return renderer.startswith('d3d12 (') and not any(
            name in renderer for name in ('basic render', 'software', 'warp', 'llvmpipe', 'softpipe', 'swiftshader')
        )
    finally:
        egl.eglMakeCurrent(display, None, None, None)
        if context:
            egl.eglDestroyContext(display, context)
        if surface:
            egl.eglDestroySurface(display, surface)
        egl.eglTerminate(display)


if __name__ == '__main__':
    try:
        raise SystemExit(0 if supports_d3d12() else 1)
    except (AttributeError, OSError):
        raise SystemExit(1) from None
