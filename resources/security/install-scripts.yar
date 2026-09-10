// Node CLI Plus installation-script indicators, ruleset 1.0.0.
// These rules identify suspicious syntax, not observed runtime behavior.
import "math"

rule acp_encoded_entropy {
  meta:
    title = "High-entropy string or decoded payload"
    severity = "low"
    confidence = "low"
    description = "An extracted literal or decoded payload has high entropy; compressed and legitimate encoded data can also match."
  strings:
    $literal = "ACP_LITERAL\n"
    $decoded = "ACP_DECODED\n"
  condition:
    ($literal at 0 and filesize >= 268 and math.entropy(12, filesize - 12) >= 5.2) or
    ($decoded at 0 and filesize >= 1036 and math.entropy(12, filesize - 12) >= 7.2)
}

rule acp_process_api {
  meta:
    title = "Process execution capability"
    severity = "low"
    confidence = "low"
    description = "The installation path references process execution. Compilers and legitimate installers commonly do this."
  strings:
    $a = "child_process"
    $b = /\b(spawnSync|execFileSync|execSync|execFile)\s*\(/
    $c = /\b(Start-Process|Invoke-Expression)\b/ nocase
  condition: any of them
}

rule acp_crypto_api {
  meta:
    title = "Encryption or decoding capability"
    severity = "low"
    confidence = "low"
    description = "Decryption or encoded string reconstruction is present. This alone is not evidence of malware."
  strings:
    $a = "createDecipher"
    $b = "fromCharCode"
    $c = /\b(atob|decrypt)\s*\(/
  condition: any of them
}

rule acp_download {
  meta:
    title = "Network download capability"
    severity = "low"
    confidence = "low"
    description = "The installation path contains network retrieval syntax; downloading platform binaries is common in legitimate installers."
  strings:
    $a = /\b(curl|wget)\s+/
    $b = /\b(https?|fetch)\s*(\.get\s*)?\(/
    $c = /\b(Invoke-WebRequest|DownloadString|DownloadFile)\b/ nocase
  condition: any of them
}

rule acp_encoded_execution {
  meta:
    title = "Decoding combined with dynamic code execution"
    severity = "moderate"
    confidence = "medium"
    description = "Encoding or decryption occurs alongside dynamic evaluation in the same installation input. Inspect whether decoded data becomes executable code."
  strings:
    $decode1 = /\b(atob|fromCharCode|createDecipher(iv)?|decrypt)\b/
    $decode2 = /["'](base64|hex)["']/
    $decode3 = /charCodeAt\([^\r\n]{0,80}\^[^\r\n]{1,40}/
    $exec1 = /\beval\s*\(/
    $exec2 = /\b(new\s+)?Function\s*\(/
    $exec3 = /\b(runInNewContext|runInThisContext|compileFunction)\s*\(/
  condition: any of ($decode*) and any of ($exec*)
}

rule acp_hidden_shell {
  meta:
    title = "Encoded or hidden shell execution"
    severity = "high"
    confidence = "medium"
    description = "Shell invocation is combined with encoded commands, hidden windows, or detached execution. Inspect the command and its payload."
  strings:
    $shell1 = /\b(powershell|pwsh)(\.exe)?\b/ nocase
    $shell2 = /["'](cmd(\.exe)?|bash|sh)["']/ nocase
    $option1 = /-(enc|encodedcommand|e)\s+[A-Za-z0-9+\/]{20}/ nocase
    $option2 = /-windowstyle\s+hidden/ nocase
    $option3 = /\b(detached|windowsHide)\s*:\s*true/
  condition: any of ($shell*) and any of ($option*)
}

rule acp_download_execute {
  meta:
    title = "Download piped into a command interpreter"
    severity = "high"
    confidence = "high"
    description = "Network retrieval is directly combined with interpreter execution. Review the remote source and the installation command."
  strings:
    $a = /\b(curl|wget)\b[^\r\n]{0,400}\|\s*(bash|sh|zsh|node)\b/
    $b = /\b(iex|Invoke-Expression)\b[^\r\n]{0,300}\b(DownloadString|Invoke-WebRequest)\b/ nocase
    $c = /\b(DownloadString|Invoke-WebRequest)\b[^\r\n]{0,300}\|\s*(iex|Invoke-Expression)\b/ nocase
  condition: any of them
}

rule acp_credential_network {
  meta:
    title = "Credential collection alongside network transmission"
    severity = "high"
    confidence = "medium"
    description = "Credential locations or bulk environment collection occur alongside outbound transmission syntax. Co-occurrence does not establish data flow."
  strings:
    $secret1 = ".npmrc"
    $secret2 = ".ssh/"
    $secret3 = ".aws/credentials"
    $secret4 = /JSON\.stringify\s*\(\s*process\.env\s*\)/
    $read1 = "readFile"
    $read2 = "process.env"
    $send1 = /\b(fetch|request|resolveTxt|resolve4|send)\s*\(/
    $send2 = /\b(curl|wget)\b[^\r\n]{0,150}(--data|-d|--post)/
  condition: any of ($secret*) and any of ($read*) and any of ($send*)
}

rule acp_persistence {
  meta:
    title = "Persistence or security-tool tampering indicators"
    severity = "high"
    confidence = "medium"
    description = "Installation input contains commands associated with persistence or disabling security controls. Verify the intended effect."
  strings:
    $a = /schtasks(\.exe)?\s+\/create/ nocase
    $b = "CurrentVersion\\Run" nocase
    $c = /Set-MpPreference\s+-DisableRealtimeMonitoring/ nocase
    $d = /\b(crontab|launchctl)\b[^\r\n]{0,100}(load|install|-)/
    $profile1 = ".bashrc"
    $profile2 = ".zshrc"
    $write1 = "appendFile"
    $write2 = ">>"
  condition: any of ($a, $b, $c, $d) or (any of ($profile*) and any of ($write*))
}

rule acp_temp_executable {
  meta:
    title = "Executing a file from a temporary location"
    severity = "moderate"
    confidence = "medium"
    description = "Process execution and temporary executable paths occur together. Inspect the executable origin; legitimate installers can also match."
  strings:
    $tmp1 = /[\/\\]tmp[\/\\][^\r\n"']{1,100}/
    $tmp2 = /%TEMP%[\/\\]/ nocase
    $tmp3 = "os.tmpdir"
    $exec1 = /\b(execFile|execFileSync|spawn|spawnSync)\s*\(/
  condition: any of ($tmp*) and $exec1
}
