package main

import (
	"archive/zip"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	appURL  = "http://127.0.0.1:8765/"
	version = "1.1.1"
)

// buildID is replaced with the payload SHA-256 by windows/build-exe.sh.
var buildID = "dev"

//go:embed payload.zip
var payloadZip []byte

type healthResponse struct {
	OK      bool   `json:"ok"`
	Storage string `json:"storage"`
}

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

func main() {
	if serverIsReady() {
		if err := openBrowser(appURL); err != nil {
			showError("MeetNote could not open the browser", err)
		}
		return
	}

	installDir, storageDir, logPath, err := prepareDirectories()
	if err != nil {
		showError("MeetNote could not prepare its local files", err)
		return
	}
	if err := installPayload(installDir); err != nil {
		showError("MeetNote could not install its bundled runtime", err)
		return
	}

	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		showError("MeetNote could not open its log file", err)
		return
	}
	defer logFile.Close()

	nodePath := filepath.Join(installDir, "runtime", "node.exe")
	serverPath := filepath.Join(installDir, "app", "server.js")
	command := exec.Command(nodePath, serverPath)
	command.Dir = filepath.Join(installDir, "app")
	command.Env = append(os.Environ(), "MEETNOTE_STORAGE_DIR="+storageDir)
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}

	if err := command.Start(); err != nil {
		showError("MeetNote could not start its local server", err)
		return
	}
	jobHandle, err := createKillOnCloseJob(command.Process.Pid)
	if err != nil {
		_ = command.Process.Kill()
		showError("MeetNote could not manage its local server", err)
		return
	}
	defer syscall.CloseHandle(jobHandle)

	ready := false
	for attempt := 0; attempt < 80; attempt++ {
		if serverIsReady() {
			ready = true
			break
		}
		if command.ProcessState != nil && command.ProcessState.Exited() {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if !ready {
		_ = command.Process.Kill()
		showError("MeetNote could not start", fmt.Errorf("check the log at %s", logPath))
		return
	}

	if err := openBrowser(appURL); err != nil {
		_ = command.Process.Kill()
		showError("MeetNote could not open the browser", err)
		return
	}

	// Keep the launcher alive as the owner of the local Node server. Starting the
	// EXE again simply focuses the app by opening its URL and exits immediately.
	if err := command.Wait(); err != nil {
		showError("MeetNote stopped unexpectedly", fmt.Errorf("%v; check %s", err, logPath))
	}
}

func prepareDirectories() (installDir, storageDir, logPath string, err error) {
	localAppData := os.Getenv("LOCALAPPDATA")
	appData := os.Getenv("APPDATA")
	if localAppData == "" || appData == "" {
		return "", "", "", errors.New("Windows application data folders are unavailable")
	}

	safeBuildID := buildID
	if len(safeBuildID) > 16 {
		safeBuildID = safeBuildID[:16]
	}
	installDir = filepath.Join(localAppData, "MeetNote", "Runtime", version+"-"+safeBuildID)
	storageDir = filepath.Join(appData, "MeetNote")
	logDir := filepath.Join(localAppData, "MeetNote", "Logs")
	for _, directory := range []string{installDir, storageDir, logDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return "", "", "", err
		}
	}
	return installDir, storageDir, filepath.Join(logDir, "server.log"), nil
}

func installPayload(installDir string) error {
	markerPath := filepath.Join(installDir, ".payload-"+buildID)
	if _, err := os.Stat(markerPath); err == nil {
		return nil
	}

	archivePath := filepath.Join(installDir, ".payload.zip")
	if err := os.WriteFile(archivePath, payloadZip, 0o600); err != nil {
		return err
	}
	defer os.Remove(archivePath)

	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()

	cleanRoot := filepath.Clean(installDir) + string(os.PathSeparator)
	for _, entry := range reader.File {
		target := filepath.Join(installDir, filepath.FromSlash(entry.Name))
		cleanTarget := filepath.Clean(target)
		if !strings.HasPrefix(cleanTarget, cleanRoot) {
			return fmt.Errorf("invalid bundled path: %s", entry.Name)
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(cleanTarget, 0o700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(cleanTarget), 0o700); err != nil {
			return err
		}
		source, err := entry.Open()
		if err != nil {
			return err
		}
		destination, err := os.OpenFile(cleanTarget, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(destination, source)
		closeErr := destination.Close()
		source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}

	return os.WriteFile(markerPath, []byte(buildID+"\n"), 0o600)
}

func serverIsReady() bool {
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(appURL + "api/health")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var health healthResponse
	return json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health) == nil && health.OK && health.Storage == "file"
}

func openBrowser(url string) error {
	return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start()
}

func createKillOnCloseJob(pid int) (syscall.Handle, error) {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	createJobObject := kernel32.NewProc("CreateJobObjectW")
	setInformationJobObject := kernel32.NewProc("SetInformationJobObject")
	assignProcessToJobObject := kernel32.NewProc("AssignProcessToJobObject")
	openProcess := kernel32.NewProc("OpenProcess")

	jobValue, _, createErr := createJobObject.Call(0, 0)
	if jobValue == 0 {
		return 0, createErr
	}
	jobHandle := syscall.Handle(jobValue)
	limits := jobObjectExtendedLimitInformation{}
	limits.BasicLimitInformation.LimitFlags = 0x00002000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	result, _, setErr := setInformationJobObject.Call(
		uintptr(jobHandle),
		9, // JobObjectExtendedLimitInformation
		uintptr(unsafe.Pointer(&limits)),
		unsafe.Sizeof(limits),
	)
	if result == 0 {
		syscall.CloseHandle(jobHandle)
		return 0, setErr
	}

	const processAccess = 0x0100 | 0x0001 // PROCESS_SET_QUOTA | PROCESS_TERMINATE
	processValue, _, openErr := openProcess.Call(processAccess, 0, uintptr(uint32(pid)))
	if processValue == 0 {
		syscall.CloseHandle(jobHandle)
		return 0, openErr
	}
	processHandle := syscall.Handle(processValue)
	defer syscall.CloseHandle(processHandle)
	result, _, assignErr := assignProcessToJobObject.Call(uintptr(jobHandle), uintptr(processHandle))
	if result == 0 {
		syscall.CloseHandle(jobHandle)
		return 0, assignErr
	}
	return jobHandle, nil
}

func showError(title string, err error) {
	message := title
	if err != nil {
		message += "\n\n" + err.Error()
	}
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	textPtr, _ := syscall.UTF16PtrFromString(message)
	titlePtr, _ := syscall.UTF16PtrFromString("MeetNote")
	_, _, _ = messageBox.Call(0, uintptr(unsafe.Pointer(textPtr)), uintptr(unsafe.Pointer(titlePtr)), 0x10)
}
