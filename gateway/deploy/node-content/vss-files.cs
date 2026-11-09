// Inspect the immutable device namespace, including reparse points that Node does not represent as links.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class HgwVssFiles {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct Entry {
        internal UInt32 Attributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        internal UInt32 SizeHigh, SizeLow, Reserved0, Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] internal string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=14)] internal string ShortName;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct StreamEntry {
        internal Int64 Size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=296)] internal string Name;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern UInt32 GetFileAttributesW(string path);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr FindFirstFileW(string path,out Entry data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool FindNextFileW(IntPtr handle,out Entry data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr FindFirstStreamW(string path,int level,out StreamEntry data,int flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool FindNextStreamW(IntPtr handle,out StreamEntry data);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool FindClose(IntPtr handle);
    private static readonly IntPtr Invalid=new IntPtr(-1);

    private static UInt32 Attributes(string path) {
        UInt32 attr=GetFileAttributesW(path);
        if(attr==UInt32.MaxValue){
            int err=Marshal.GetLastWin32Error();
            if(err!=2 && err!=3)throw new Win32Exception(err);
        } else if((attr&0x440)!=0)throw new InvalidOperationException("The snapshot contains a reparse point or device.");
        return attr;
    }

    private static void CheckStreams(string path){
        StreamEntry data;
        IntPtr handle=FindFirstStreamW(path,0,out data,0);
        if(handle==Invalid){
            int err=Marshal.GetLastWin32Error();
            if(err==38)return;
            throw new Win32Exception(err);
        }
        try{
            do{if(data.Name!="::$DATA")throw new InvalidOperationException("A named stream needs its own backup provider.");}
            while(FindNextStreamW(handle,out data));
            int err=Marshal.GetLastWin32Error();
            if(err!=38)throw new Win32Exception(err);
        } finally{FindClose(handle);}
    }

    // Inputs are relative to precisely this shadow device; an absent protected root may remain absent.
    public static void Inspect(string device,string[] paths,int maximum){
        var pending=new Stack<string>();
        var seen=new HashSet<string>(StringComparer.Ordinal);
        foreach(string relative in paths){
            string current=device;
            foreach(string part in relative.Split('\\')){
                if(part.Length==0 || part=="." || part==".." || part.IndexOfAny(new char[]{':','/','\0'})>=0)
                    throw new ArgumentException("Invalid path within the selected volume.");
                current+="\\"+part;
                if(Attributes(current)==UInt32.MaxValue)break;
            }
            pending.Push(device+"\\"+relative);
        }
        while(pending.Count!=0){
            string path=pending.Pop();
            if(!seen.Add(path))continue;
            if(seen.Count>maximum)throw new InvalidOperationException("Snapshot membership exceeds the configured limit.");
            UInt32 attr=Attributes(path);
            if(attr==UInt32.MaxValue)continue;
            CheckStreams(path);
            if((attr&0x10)==0)continue;
            Entry data;
            IntPtr handle=FindFirstFileW(path+"\\*",out data);
            if(handle==Invalid){
                int err=Marshal.GetLastWin32Error();
                if(err==2)continue;
                throw new Win32Exception(err);
            }
            try{
                do{
                    if(data.Name!="." && data.Name!=".."){
                        if(pending.Count>=maximum)throw new InvalidOperationException("Snapshot membership exceeds the configured limit.");
                        pending.Push(path+"\\"+data.Name);
                    }
                }while(FindNextFileW(handle,out data));
                int err=Marshal.GetLastWin32Error();
                if(err!=18)throw new Win32Exception(err);
            }finally{FindClose(handle);}
        }
    }
}
