"""Shared scene kit for the Exit Market 3D shots (Blender 4.5 LTS, Cycles + OptiX, run headless).

Every shot script builds its scene from these helpers, then calls `render_from_cli`:
  blender -b --factory-startup -P video/blender/shot1_lock.py -- --out video/out/shots/shot1 [--still 120] [--preview]
"""
import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

VIDEO_DIR = Path(__file__).resolve().parent.parent
FONTS = VIDEO_DIR / "assets" / "fonts"
FPS = 30

# Palette of the web app's dark theme (sRGB hex), converted to linear on use.
COLORS = {
    "bg": "#07090d",
    "ink": "#e8ebf0",
    "muted": "#8b95a5",
    "blue": "#4c93f5",
    "arb": "#28a0f0",
    "eth": "#8c8dfc",
    "l3": "#3fd0c9",
    "amber": "#e0a345",
    "green": "#3fbf88",
}


def lin(hex_color: str, alpha: float = 1.0) -> tuple:
    """sRGB hex -> linear RGBA (Blender works in linear)."""
    h = hex_color.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, alpha)


# ---------------------------------------------------------------- scene + render


def reset_scene(seconds: float) -> bpy.types.Scene:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = max(1, round(seconds * FPS))
    scene.render.fps = FPS
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48  # OptiX denoising cleans the rest; scenes are mostly emissive
    try:
        scene.render.compositor_device = "GPU"  # the Fog Glow pass is slow on CPU at 1080p
    except (AttributeError, TypeError):
        pass
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.cycles.transmission_bounces = 8
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    try:
        scene.view_settings.look = "AgX - Punchy"
    except TypeError:
        pass  # look names differ across builds; AgX base is fine
    _use_gpu(scene)
    _world(scene)
    _glare(scene)
    return scene


def _use_gpu(scene) -> None:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
        except TypeError:
            continue
        devices = [d for d in prefs.devices if d.type == backend]
        if devices:
            for d in prefs.devices:
                d.use = d.type == backend
            scene.cycles.device = "GPU"
            if backend == "OPTIX":
                scene.cycles.denoiser = "OPTIX"
            print(f"[lib] rendering on {backend}: {[d.name for d in devices]}")
            return
    print("[lib] no NVIDIA GPU found, rendering on CPU")


def _world(scene) -> None:
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = lin(COLORS["bg"])
    bg.inputs["Strength"].default_value = 1.0


def _set(node, name: str, value) -> None:
    """Sets a node setting whether this Blender build exposes it as a property or as an input socket."""
    if hasattr(node, name):
        setattr(node, name, value)
        return
    for sock in node.inputs:
        if sock.name.lower() == name.replace("_", " ").lower():
            sock.default_value = value
            return


def _glare(scene) -> None:
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()
    layers = tree.nodes.new("CompositorNodeRLayers")
    glare = tree.nodes.new("CompositorNodeGlare")
    _set(glare, "glare_type", "FOG_GLOW")
    _set(glare, "quality", "HIGH")
    _set(glare, "threshold", 0.9)
    _set(glare, "mix", -0.55)
    _set(glare, "size", 8)
    out = tree.nodes.new("CompositorNodeComposite")
    tree.links.new(layers.outputs["Image"], glare.inputs["Image"])
    tree.links.new(glare.outputs["Image"], out.inputs["Image"])


def render_from_cli(scene) -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--still", type=int, help="render only this frame")
    parser.add_argument("--preview", action="store_true", help="half resolution, few samples")
    parser.add_argument("--samples", type=int)
    parser.add_argument("--frames", help="start-end subset, e.g. 1-120")
    args = parser.parse_args(argv)

    if args.preview:
        scene.render.resolution_percentage = 50
        scene.cycles.samples = 16
    if args.samples:
        scene.cycles.samples = args.samples
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    if args.still:
        scene.frame_set(args.still)
        scene.render.filepath = str(out / f"still_{args.still:04d}.png")
        bpy.ops.render.render(write_still=True)
        return
    if args.frames:
        start, end = (int(x) for x in args.frames.split("-"))
        scene.frame_start, scene.frame_end = start, end
    scene.render.filepath = str(out / "frame_")
    scene.render.use_overwrite = False  # resumable: skip frames already on disk
    scene.render.use_placeholder = True
    bpy.ops.render.render(animation=True)


# ---------------------------------------------------------------- materials


def mat_emission(name: str, color: str, strength: float) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    em = nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = lin(color)
    em.inputs["Strength"].default_value = strength
    out = nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return mat


def emission_strength_socket(mat: bpy.types.Material):
    return mat.node_tree.nodes["Emission"].inputs["Strength"]


def mat_principled(name: str, color: str, *, metallic=0.0, roughness=0.4, transmission=0.0, ior=1.45,
                   emission: str | None = None, emission_strength=0.0) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = lin(color)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Transmission Weight"].default_value = transmission
    bsdf.inputs["IOR"].default_value = ior
    if emission:
        bsdf.inputs["Emission Color"].default_value = lin(emission)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def mat_glass(name: str, tint: str, roughness=0.12) -> bpy.types.Material:
    return mat_principled(name, tint, roughness=roughness, transmission=1.0, ior=1.45)


def mat_floor_grid(name="FloorGrid", line_color=COLORS["blue"], spacing=1.0) -> bpy.types.Material:
    """Dark glossy floor with a faint emissive grid (object-space fract lines)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = lin("#0a0d13")
    bsdf.inputs["Roughness"].default_value = 0.28
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    lines = []
    for axis in ("X", "Y"):
        scale = nt.nodes.new("ShaderNodeMath")
        scale.operation = "DIVIDE"
        scale.inputs[1].default_value = spacing
        nt.links.new(sep.outputs[axis], scale.inputs[0])
        frac = nt.nodes.new("ShaderNodeMath")
        frac.operation = "FRACT"
        nt.links.new(scale.outputs[0], frac.inputs[0])
        thin = nt.nodes.new("ShaderNodeMath")
        thin.operation = "LESS_THAN"
        thin.inputs[1].default_value = 0.012
        nt.links.new(frac.outputs[0], thin.inputs[0])
        lines.append(thin)
    both = nt.nodes.new("ShaderNodeMath")
    both.operation = "MAXIMUM"
    nt.links.new(lines[0].outputs[0], both.inputs[0])
    nt.links.new(lines[1].outputs[0], both.inputs[1])
    strength = nt.nodes.new("ShaderNodeMath")
    strength.operation = "MULTIPLY"
    strength.inputs[1].default_value = 0.35
    nt.links.new(both.outputs[0], strength.inputs[0])
    bsdf.inputs["Emission Color"].default_value = lin(line_color)
    nt.links.new(strength.outputs[0], bsdf.inputs["Emission Strength"])
    return mat


# ---------------------------------------------------------------- objects


def _link(obj) -> bpy.types.Object:
    bpy.context.scene.collection.objects.link(obj)
    return obj


def assign(obj, mat) -> bpy.types.Object:
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


def _apply_scale_only() -> None:
    """Bake scale into the mesh (for even bevels) but keep location, so objects can be animated and parented.
    transform_apply defaults to applying location and rotation too, which double-offsets animated objects."""
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def box(name: str, size: tuple, loc: tuple, mat=None, bevel=0.04) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    _apply_scale_only()
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    bpy.ops.object.shade_smooth()
    return assign(obj, mat) if mat else obj


def edge_frame(name: str, size: tuple, loc: tuple, mat, thickness=0.02) -> bpy.types.Object:
    """Glowing outline of a box (wireframe of its edges)."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    _apply_scale_only()
    mod = obj.modifiers.new("Wire", "WIREFRAME")
    mod.thickness = thickness
    mod.use_even_offset = True
    return assign(obj, mat)


def sphere(name: str, radius: float, loc: tuple, mat=None, scale=(1, 1, 1)) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc, segments=48, ring_count=24)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.shade_smooth()
    return assign(obj, mat) if mat else obj


def torus(name: str, major: float, minor: float, loc: tuple, mat=None, rotation=(0, 0, 0)) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=loc, rotation=rotation,
                                     major_segments=96, minor_segments=16)
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.shade_smooth()
    return assign(obj, mat) if mat else obj


def cylinder(name: str, radius: float, depth: float, loc: tuple, mat=None, rotation=(0, 0, 0)) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc, rotation=rotation, vertices=64)
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.shade_smooth()
    return assign(obj, mat) if mat else obj


def rod(name: str, a: Vector, b: Vector, radius: float, mat) -> bpy.types.Object:
    """Cylinder spanning point a to point b."""
    a, b = Vector(a), Vector(b)
    d = b - a
    obj = cylinder(name, radius, d.length, (a + b) / 2, mat)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = d.to_track_quat("Z", "Y")
    return obj


def text(body: str, loc: tuple, size: float, mat, *, font="JetBrainsMono-Bold.ttf", rotation=(math.radians(90), 0, 0),
         extrude=0.0, align="CENTER", name=None) -> bpy.types.Object:
    curve = bpy.data.curves.new(name or f"txt_{body[:12]}", type="FONT")
    curve.body = body
    curve.size = size
    curve.extrude = extrude
    curve.align_x = align
    curve.align_y = "CENTER"
    font_path = FONTS / font
    if font_path.exists():
        curve.font = bpy.data.fonts.load(str(font_path), check_existing=True)
    obj = _link(bpy.data.objects.new(name or curve.name, curve))
    obj.location = loc
    obj.rotation_euler = rotation
    obj.data.materials.append(mat)
    return obj


def check_mark(name: str, loc: tuple, size: float, mat, rotation=(math.radians(90), 0, 0)) -> bpy.types.Object:
    """A glowing check mark built from a beveled poly curve."""
    curve = bpy.data.curves.new(name, type="CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = size * 0.09
    curve.bevel_resolution = 4
    spline = curve.splines.new("POLY")
    pts = [(-0.5, 0.05), (-0.15, -0.35), (0.55, 0.45)]
    spline.points.add(len(pts) - 1)
    for p, (x, y) in zip(spline.points, pts):
        p.co = (x * size, y * size, 0, 1)
    obj = _link(bpy.data.objects.new(name, curve))
    obj.location = loc
    obj.rotation_euler = rotation
    obj.data.materials.append(mat)
    return obj


def area_light(name: str, loc: tuple, target: tuple, energy: float, size: float, color="#ffffff") -> bpy.types.Object:
    data = bpy.data.lights.new(name, type="AREA")
    data.energy = energy
    data.size = size
    data.color = lin(color)[:3]
    obj = _link(bpy.data.objects.new(name, data))
    obj.location = loc
    look_at(obj, target)
    return obj


def point_light(name: str, loc: tuple, energy: float, color: str, radius=0.1) -> bpy.types.Object:
    data = bpy.data.lights.new(name, type="POINT")
    data.energy = energy
    data.color = lin(color)[:3]
    data.shadow_soft_size = radius
    obj = _link(bpy.data.objects.new(name, data))
    obj.location = loc
    return obj


def look_at(obj, target) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def camera(loc: tuple, target: tuple, lens=40.0) -> tuple:
    """Camera tracking an empty; animate either one. Returns (camera, target_empty)."""
    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = lens
    cam = _link(bpy.data.objects.new("Camera", cam_data))
    cam.location = loc
    aim = _link(bpy.data.objects.new("Aim", None))
    aim.location = target
    track = cam.constraints.new("TRACK_TO")
    track.target = aim
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    bpy.context.scene.camera = cam
    return cam, aim


def floor(z: float, size=80.0, mat=None) -> bpy.types.Object:
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, z))
    obj = bpy.context.active_object
    obj.name = "Floor"
    return assign(obj, mat or mat_floor_grid())


# ---------------------------------------------------------------- animation


def key(obj, path: str, frame: int, value, index: int = -1) -> None:
    """Keyframe obj.<path> (or a socket's default_value) to `value` at `frame` (Bezier ease in/out)."""
    if index >= 0:
        getattr(obj, path)[index] = value
    else:
        setattr(obj, path, value)
    obj.keyframe_insert(data_path=path, frame=frame, index=index)


def key_socket(socket, frame: int, value) -> None:
    socket.default_value = value
    socket.keyframe_insert("default_value", frame=frame)


def drive(obj, path: str, index: int, expression: str) -> None:
    """Continuous motion via a simple-expression driver (e.g. 'sin(frame/20)*0.1'); no keyframes needed."""
    fcurve = obj.driver_add(path, index)
    fcurve.driver.type = "SCRIPTED"
    fcurve.driver.expression = expression


def seconds(s: float) -> int:
    return max(1, round(s * FPS))
