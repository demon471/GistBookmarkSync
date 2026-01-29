
/**
 * 将字符串转换为 Base64 (支持 UTF-8)
 */
export function strToBase64(str: string): string {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
        (_, p1) => String.fromCharCode(parseInt(p1, 16))))
}

/**
 * 将 Base64 转换为字符串 (支持 UTF-8)
 */
export function base64ToStr(str: string): string {
    return decodeURIComponent(Array.prototype.map.call(atob(str),
        (c: string) => `%${(`00${c.charCodeAt(0).toString(16)}`).slice(-2)}`).join(''))
}

/**
 * 使用 Gzip 压缩数据并转为 Base64
 */
export async function compressData(data: unknown): Promise<string> {
    // 1. 转为 JSON 字符串
    const jsonStr = JSON.stringify(data)

    // 2. 使用 Gzip 压缩
    const stream = new Blob([jsonStr]).stream()
    const compressedStream = stream.pipeThrough(new CompressionStream('gzip'))
    const response = await new Response(compressedStream).arrayBuffer()

    // 3. 转为 Base64 字符串
    // 使用 Uint8Array 转 binary string 再转 base64
    let binary = ''
    const bytes = new Uint8Array(response)
    const len = bytes.byteLength
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i])
    }

    // 添加前缀以便识别
    return `GZIP:${btoa(binary)}`
}

/**
 * 解压数据 (支持自动识别压缩/非压缩)
 */
export async function decompressData<T>(data: string | T): Promise<T> {
    // 如果已经是对象，直接返回
    if (typeof data !== 'string')
        return data as T

    // 1. 尝试直接解析 JSON (旧版数据兼容)
    try {
        const trimmed = data.trim()
        if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
            return JSON.parse(data)
        }
    }
    catch {
        // 忽略错误，继续尝试解压
    }

    // 2. 检查前缀
    let base64 = data
    if (data.startsWith('GZIP:')) {
        base64 = data.slice(5)
    } else {
        // 如果不是 GZIP 前缀也不是 JSON，可能不是我们的数据，或者是纯 Base64 (如果不带前缀的话)
        // 这里假设如果不是 JSON，就是我们需要解压的数据
    }

    try {
        // 3. Base64 转二进制
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
        }

        // 4. Gzip 解压
        const stream = new Blob([bytes]).stream()
        const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'))
        const response = await new Response(decompressedStream).text()

        return JSON.parse(response)
    } catch (error) {
        // console.debug('Decompression failed:', error)
        // 如果解压失败，最后尝试一次直接 parse，也许是看起来不像 JSON 的 JSON
        try {
            return JSON.parse(data)
        } catch {
            throw new Error('无法解析数据：格式不正确或已损坏')
        }
    }
}
