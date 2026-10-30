// ocr.swift — 用 macOS Vision 做中英文文字识别，输出 JSON（含屏幕点坐标）
//
// 用法: ocr <图片路径> [regionX regionY regionW regionH]
//   给了 region 就把它当作屏幕点坐标系下的区域，输出的坐标会换算回全局屏幕点；
//   不给则认为是整屏截图，按图片尺寸推断。
//
// 输出: {"width":..,"height":..,"items":[{"text":..,"x":..,"y":..,"w":..,"h":..,"conf":..}]}

import Foundation
import Vision
import AppKit

func die(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 1 else { die("用法: ocr <图片路径> [x y w h]") }

let imagePath = args[0]
guard let image = NSImage(contentsOfFile: imagePath),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cgImage = bitmap.cgImage else {
    die("读不到图片: \(imagePath)")
}

let imgW = Double(cgImage.width)
let imgH = Double(cgImage.height)

// region 用屏幕点表示；不给就用图片像素当点（scale=1）
var originX = 0.0, originY = 0.0, regionW = imgW, regionH = imgH
if args.count >= 5 {
    originX = Double(args[1]) ?? 0
    originY = Double(args[2]) ?? 0
    regionW = Double(args[3]) ?? imgW
    regionH = Double(args[4]) ?? imgH
}
// 图片像素 → 屏幕点的换算系数
let sx = regionW / imgW
let sy = regionH / imgH

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    die("OCR 失败: \(error)")
}

var items: [[String: Any]] = []
if let observations = request.results {
    for obs in observations {
        guard let candidate = obs.topCandidates(1).first else { continue }
        let bb = obs.boundingBox  // 归一化，原点在左下
        // Vision 的 y 向上，屏幕坐标 y 向下
        let x = originX + Double(bb.minX) * regionW
        let y = originY + (1.0 - Double(bb.maxY)) * regionH
        let w = Double(bb.width) * regionW
        let h = Double(bb.height) * regionH
        items.append([
            "text": candidate.string,
            "x": (x * 10).rounded() / 10,
            "y": (y * 10).rounded() / 10,
            "w": (w * 10).rounded() / 10,
            "h": (h * 10).rounded() / 10,
            "cx": ((x + w / 2) * 10).rounded() / 10,
            "cy": ((y + h / 2) * 10).rounded() / 10,
            "conf": (Double(candidate.confidence) * 100).rounded() / 100,
        ])
    }
}

let out: [String: Any] = [
    "image": imagePath,
    "pixelWidth": Int(imgW),
    "pixelHeight": Int(imgH),
    "pointWidth": regionW,
    "pointHeight": regionH,
    "count": items.count,
    "items": items,
]

let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
